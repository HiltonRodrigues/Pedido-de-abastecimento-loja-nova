/* ============================================================
   Cardex ⇄ Pedido — núcleo da aplicação
   Persistência: JSONBin.io via Cloudflare Worker | Leitura de Excel: SheetJS
   ============================================================ */

// URL fixo do Cloudflare Worker que faz a ponte com o JSONBin.
// Não é preciso nenhuma configuração pelo utilizador — a app liga-se
// automaticamente a este endereço ao abrir.
const WORKER_URL = 'https://cardex-pedido-api.rodrigueshilton13.workers.dev';

const STORAGE_LOCAL_KEY = 'cardex_pedido_local_v1';

const STATE = {
  step: 0,
  jsonbin: { connected: false },
  storeName: '',
  config: {
    coberturaObjDias: 10,
    janelaVendasDias: 10,
    pesoCategoriaReforco: 0.5, // 0..1 — quanto menor, mais reduz o reforço de artigos da mesma categoria já bem servidos
  },
  cardex: { raw: null, fileName: '', mapping: {}, items: [] },
  stock: { raw: null, fileName: '', mapping: {}, items: [] },
  vendas: { raw: null, fileName: '', mapping: {}, items: [], mediaPorArtigo: {}, periodoDias: 10 },
  pedidoSugerido: [],   // resultado do cálculo passo 4
  pedidoFinal: [],      // pedido editado/aprovado pelo utilizador
  nivelServico: { raw: null, fileName: '', mapping: {}, items: [] },
  reforco: [],          // sugestão de reforço (passo 6)
  history: []           // snapshots de pedidos anteriores (para auditoria)
};

const STEPS = [
  { key: 'config',   title: 'Ligação de dados' },
  { key: 'cardex',   title: '1 · Cardex' },
  { key: 'stock',    title: '2 · Stock' },
  { key: 'vendas',   title: '3 · Vendas' },
  { key: 'pedido',   title: '4 · Pedido sugerido' },
  { key: 'servico',  title: '5 · Nível de serviço' },
  { key: 'reforco',  title: '6 · Reforço' },
];

// ---------------------------------------------------------------
// Toast / feedback
// ---------------------------------------------------------------
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast-msg' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------------------------------------------------------------
// Local persistence (fallback / cache rápida no browser)
// ---------------------------------------------------------------
function saveLocal() {
  try {
    localStorage.setItem(STORAGE_LOCAL_KEY, JSON.stringify(STATE));
  } catch (e) { /* quota / private mode — ignore silently */ }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_LOCAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(STATE, parsed);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ---------------------------------------------------------------
// Persistência na nuvem — sempre através do Worker (WORKER_URL fixo)
// ---------------------------------------------------------------
async function cloudRead() {
  const res = await fetch(WORKER_URL, { method: 'GET' });
  if (!res.ok) throw new Error('Falha ao ler dados da nuvem (' + res.status + ')');
  const j = await res.json();
  return j.record || j;
}

// Funde o record vindo da nuvem no STATE local, preservando defaults para
// campos que possam não existir em registos gravados por versões anteriores.
function mergeRemoteState(record) {
  STATE.step = record.step ?? STATE.step;
  STATE.storeName = record.storeName ?? STATE.storeName;
  STATE.config = { ...STATE.config, ...(record.config || {}) };
  STATE.cardex = { raw: null, fileName: record.cardex?.fileName || '', mapping: record.cardex?.mapping || {}, items: record.cardex?.items || [] };
  STATE.stock = { raw: null, fileName: record.stock?.fileName || '', mapping: record.stock?.mapping || {}, items: record.stock?.items || [] };
  STATE.vendas = {
    raw: null, fileName: record.vendas?.fileName || '', mapping: record.vendas?.mapping || {},
    items: record.vendas?.items || [], mediaPorArtigo: record.vendas?.mediaPorArtigo || {}, periodoDias: record.vendas?.periodoDias || 10
  };
  STATE.pedidoSugerido = record.pedidoSugerido || [];
  STATE.pedidoFinal = record.pedidoFinal || [];
  STATE.nivelServico = { raw: null, fileName: record.nivelServico?.fileName || '', mapping: record.nivelServico?.mapping || {}, items: record.nivelServico?.items || [] };
  STATE.reforco = record.reforco || [];
  STATE.history = record.history || [];
}

async function cloudWrite(data) {
  const res = await fetch(WORKER_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Falha ao gravar dados na nuvem (' + res.status + ')');
  return res.json();
}

let saveTimer = null;
function scheduleCloudSave() {
  saveLocal();
  if (!STATE.jsonbin.connected) return;
  clearTimeout(saveTimer);
  setStoreTag('a gravar…', 'busy');
  saveTimer = setTimeout(async () => {
    try {
      const payload = exportableState();
      const size = estimatePayloadSize(payload);
      if (size > 950 * 1024) {
        toast('Aviso: os dados deste ciclo (' + Math.round(size / 1024) + ' KB) estão perto do limite da nuvem (1MB). Considere aprovar o pedido/reforço e iniciar um novo ciclo para libertar espaço.', 'err');
      }
      await cloudWrite(payload);
      setStoreTag(STATE.storeName || 'na nuvem', 'ok');
    } catch (e) {
      toast('Erro ao gravar na nuvem: ' + e.message, 'err');
      setStoreTag('erro ao gravar', 'err');
    }
  }, 900);
}

function exportableState() {
  // Não persistimos a chave API no bin (fica só local), tudo o resto sim,
  // mas reduzimos agressivamente o payload para não exceder o limite de 1MB
  // dos Bins normais do JSONBin:
  //  - nunca persistimos `raw` (cópia bruta do Excel, só serve durante a sessão)
  //  - vendas: persistimos apenas o agregado (venda média por artigo), não as
  //    milhares de linhas de detalhe diário
  //  - history: mantemos só os 5 snapshots mais recentes
  const { jsonbin, ...rest } = STATE;

  const { mediaPorArtigo } = STATE.vendas.items.length
    ? calcularVendaMedia(STATE.vendas.items, STATE.config.janelaVendasDias)
    : { mediaPorArtigo: {} };

  return {
    ...rest,
    cardex: { fileName: STATE.cardex.fileName, mapping: STATE.cardex.mapping, items: STATE.cardex.items },
    stock: { fileName: STATE.stock.fileName, mapping: STATE.stock.mapping, items: STATE.stock.items },
    vendas: {
      fileName: STATE.vendas.fileName, mapping: STATE.vendas.mapping,
      linhas: STATE.vendas.items.length, mediaPorArtigo,
      items: [], // detalhe não persistido na nuvem — recarregue o ficheiro se precisar de o ver de novo
    },
    nivelServico: { fileName: STATE.nivelServico.fileName, mapping: STATE.nivelServico.mapping, items: STATE.nivelServico.items },
    history: STATE.history.slice(-5),
  };
}

function estimatePayloadSize(obj) {
  try { return new Blob([JSON.stringify(obj)]).size; } catch (e) { return JSON.stringify(obj).length; }
}

function setStoreTag(text, mode) {
  const tag = document.getElementById('storeTag');
  if (!tag) return;
  tag.textContent = text;
  tag.style.background = mode === 'err' ? 'var(--danger)' : mode === 'busy' ? '#7a7363' : 'var(--ink)';
}

// ---------------------------------------------------------------
// Excel parsing helpers (SheetJS)
// ---------------------------------------------------------------
function readWorkbookFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        resolve(wb);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Não foi possível ler o ficheiro.'));
    reader.readAsArrayBuffer(file);
  });
}

// Tenta encontrar automaticamente a linha de cabeçalho dentro das primeiras N linhas
// (lida com ficheiros que têm título/data antes do cabeçalho real, como o Cardex de exemplo)
function sheetToRowsAutoHeader(sheet, maxScan = 6) {
  const allRows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!allRows.length) return { headers: [], rows: [] };

  let bestRow = 0, bestScore = -1;
  const scanLimit = Math.min(maxScan, allRows.length);
  for (let i = 0; i < scanLimit; i++) {
    const row = allRows[i];
    const nonEmpty = row.filter(c => String(c).trim() !== '').length;
    const looksTextual = row.filter(c => typeof c === 'string' && c.trim() !== '' && isNaN(Number(c))).length;
    const score = nonEmpty + looksTextual * 2;
    if (score > bestScore && nonEmpty >= 2) { bestScore = score; bestRow = i; }
  }
  const headers = allRows[bestRow].map((h, idx) => (String(h).trim() || `Coluna ${idx + 1}`));
  const rows = allRows.slice(bestRow + 1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h, idx) => obj[h] = r[idx] !== undefined ? r[idx] : '');
      return obj;
    });
  return { headers, rows };
}

function parseWorkbookFirstSheet(wb) {
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return { sheetName, ...sheetToRowsAutoHeader(sheet) };
}

// ---------------------------------------------------------------
// Number / text helpers
// ---------------------------------------------------------------
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\s/g, '').replace(/\./g, m => '').replace(',', '.');
  // fallback simples: remover tudo exceto dígitos, ponto e sinal
  const cleaned = String(v).replace(/[^\d,.\-]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}
function normKey(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}
function fmtNum(n, dec = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtPct(n, dec = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n * 100).toLocaleString('pt-PT', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function downloadCSV(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(';'), ...rows.map(r => r.map(esc).join(';'))];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
function downloadXLSX(filename, headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pedido');
  XLSX.writeFile(wb, filename);
}
/* ============================================================
   Motor de cálculo
   ============================================================ */

// --- 1) Venda média diária por artigo, sobre a janela configurada ------
// Espera STATE.vendas.items já mapeado para: { codigo, data, quantidade }
// `data` pode chegar como objeto Date ou como string ISO (após round-trip por
// localStorage/JSON), por isso é normalizada aqui antes de qualquer cálculo.
function asDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function calcularVendaMedia(vendasItemsRaw, janelaDias) {
  const vendasItems = vendasItemsRaw.map(v => ({ ...v, data: asDate(v.data) })).filter(v => v.data);
  const hoje = vendasItems.reduce((max, v) => v.data > max ? v.data : max, new Date(0));
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() - janelaDias + 1);

  const porArtigo = {};
  for (const v of vendasItems) {
    if (v.data < limite) continue;
    const k = normKey(v.codigo);
    if (!porArtigo[k]) porArtigo[k] = { total: 0, dias: new Set() };
    porArtigo[k].total += v.quantidade;
    porArtigo[k].dias.add(v.data.toISOString().slice(0, 10));
  }
  const out = {};
  for (const k in porArtigo) {
    out[k] = porArtigo[k].total / janelaDias; // média sobre a janela total de dias (não só dias com venda)
  }
  return { mediaPorArtigo: out, dataLimite: limite, dataMax: hoje };
}

// --- 2) Sugestão de pedido --------------------------------------------
// pedido_bruto = (venda_media_dia * cobertura_obj_dias) - stock_atual
// depois convertido para unidades de caixa (arredondado para cima) e limitado ao Cardex
function gerarPedidoSugerido({ cardex, stock, mediaPorArtigo, coberturaDias }) {
  const stockPorArtigo = {};
  for (const s of stock) stockPorArtigo[normKey(s.codigo)] = (stockPorArtigo[normKey(s.codigo)] || 0) + s.quantidade;

  return cardex.map(c => {
    const k = normKey(c.codigo);
    const vendaMediaDia = mediaPorArtigo[k] || 0;
    const stockAtual = stockPorArtigo[k] || 0;
    const necessidade = vendaMediaDia * coberturaDias - stockAtual;
    const conv = c.conversaoCaixas > 0 ? c.conversaoCaixas : 1;
    const caixasSugeridas = necessidade > 0 ? Math.ceil(necessidade / conv) : 0;
    const qtdSugerida = caixasSugeridas * conv;
    return {
      codigo: c.codigo,
      descricao: c.descricao,
      categoria: c.categoria,
      unidade: c.unidade,
      conversaoCaixas: conv,
      vendaMediaDia,
      stockAtual,
      coberturaDiasAtual: vendaMediaDia > 0 ? stockAtual / vendaMediaDia : (stockAtual > 0 ? Infinity : 0),
      necessidadeBruta: necessidade,
      caixasSugeridas,
      qtdSugerida,
      qtdPedida: qtdSugerida, // editável pelo utilizador no ecrã 4
    };
  });
}

// --- 3) Nível de serviço -----------------------------------------------
// Junta o pedido final com o ficheiro de "servido" carregado, calcula % e falta.
function calcularNivelServico(pedidoFinal, servidoItems) {
  const servidoPorArtigo = {};
  for (const s of servidoItems) {
    const k = normKey(s.codigo);
    servidoPorArtigo[k] = (servidoPorArtigo[k] || 0) + s.quantidade;
  }
  return pedidoFinal.filter(p => p.qtdPedida > 0).map(p => {
    const k = normKey(p.codigo);
    const qtdServida = servidoPorArtigo.hasOwnProperty(k) ? servidoPorArtigo[k] : null;
    const servidoConhecido = qtdServida !== null;
    const servido = servidoConhecido ? qtdServida : 0;
    const nivel = p.qtdPedida > 0 ? Math.min(servido / p.qtdPedida, 1) : null;
    const falta = Math.max(p.qtdPedida - servido, 0);
    return {
      ...p,
      qtdServida: servido,
      servidoConhecido,
      nivelServico: nivel,
      faltaEntregar: falta,
    };
  });
}

// --- 4) Sugestão de reforço ---------------------------------------------
// Critério: reforçar artigos com falta de entrega, mas reduzir o peso quando
// outros artigos da MESMA categoria já tiveram bom nível de serviço (>= limiar),
// para evitar excesso financeiro de stock numa categoria já bem suprida.
//
// pesoCategoria (0..1): fator de atenuação aplicado quando a categoria, em média,
// já está bem servida. 1 = sem atenuação; 0 = anula reforço de categorias bem servidas.
function gerarSugestaoReforco(nivelServicoItems, { pesoCategoria = 0.5, limiarBomServico = 0.95 } = {}) {
  // nível médio de serviço por categoria (apenas itens com dado conhecido)
  const porCategoria = {};
  for (const it of nivelServicoItems) {
    if (it.nivelServico === null) continue;
    const cat = it.categoria || '—';
    if (!porCategoria[cat]) porCategoria[cat] = { soma: 0, n: 0 };
    porCategoria[cat].soma += it.nivelServico;
    porCategoria[cat].n += 1;
  }
  const mediaCategoria = {};
  for (const cat in porCategoria) mediaCategoria[cat] = porCategoria[cat].soma / porCategoria[cat].n;

  return nivelServicoItems
    .filter(it => it.faltaEntregar > 0)
    .map(it => {
      const cat = it.categoria || '—';
      const nivelCategoria = mediaCategoria.hasOwnProperty(cat) ? mediaCategoria[cat] : null;
      // Se a categoria já está bem servida (média alta), atenua-se o reforço deste artigo
      // proporcionalmente ao quão bem servida está a categoria, escalado por pesoCategoria.
      let fatorAtenuacao = 1;
      if (nivelCategoria !== null && nivelCategoria >= limiarBomServico) {
        // quanto mais perto de 100% a categoria está, maior a atenuação (até ao limite pesoCategoria)
        const excedente = (nivelCategoria - limiarBomServico) / (1 - limiarBomServico || 1); // 0..1
        fatorAtenuacao = 1 - excedente * (1 - pesoCategoria);
      } else if (nivelCategoria !== null) {
        // categoria com nível médio mau -> reforço prioritário, sem atenuação
        fatorAtenuacao = 1;
      }
      const conv = it.conversaoCaixas > 0 ? it.conversaoCaixas : 1;
      const reforcoBruto = it.faltaEntregar * fatorAtenuacao;
      const caixasReforco = reforcoBruto > 0 ? Math.ceil(reforcoBruto / conv) : 0;
      const qtdReforco = caixasReforco * conv;
      return {
        codigo: it.codigo,
        descricao: it.descricao,
        categoria: cat,
        unidade: it.unidade,
        conversaoCaixas: conv,
        qtdPedidaOriginal: it.qtdPedida,
        qtdServida: it.qtdServida,
        nivelServico: it.nivelServico,
        faltaEntregar: it.faltaEntregar,
        nivelMedioCategoria: nivelCategoria,
        fatorAtenuacao,
        qtdReforcoSugerida: qtdReforco,
        qtdReforco: qtdReforco, // editável
        prioridade: fatorAtenuacao >= 0.99 ? 'alta' : fatorAtenuacao >= 0.6 ? 'media' : 'baixa',
      };
    })
    .sort((a, b) => b.faltaEntregar - a.faltaEntregar);
}
/* ============================================================
   UI — Render principal + Stepper + Ecrã 0 (Ligação de dados)
   ============================================================ */

function render() {
  renderStepper();
  const root = document.getElementById('screens');
  const key = STEPS[STATE.step].key;
  root.innerHTML = '';
  const builders = {
    config: renderConfigScreen,
    cardex: renderCardexScreen,
    stock: renderStockScreen,
    vendas: renderVendasScreen,
    pedido: renderPedidoScreen,
    servico: renderServicoScreen,
    reforco: renderReforcoScreen,
  };
  builders[key](root);
}

function goTo(stepIdx) {
  STATE.step = stepIdx;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function stepUnlocked(idx) {
  if (idx <= 1) return true; // config e cardex sempre acessíveis
  if (idx === 2) return STATE.cardex.items.length > 0; // stock precisa do cardex
  if (idx === 3) return STATE.stock.items.length > 0; // vendas precisa do stock
  if (idx === 4) return STATE.vendas.items.length > 0 || Object.keys(STATE.vendas.mediaPorArtigo || {}).length > 0; // pedido precisa de vendas
  if (idx === 5) return STATE.pedidoFinal.length > 0; // serviço precisa de pedido aprovado
  if (idx === 6) return STATE.nivelServico.items.length > 0; // reforço precisa do nível de serviço
  return false;
}

function renderStepper() {
  const el = document.getElementById('stepper');
  el.innerHTML = STEPS.map((s, i) => {
    const unlocked = stepUnlocked(i);
    const done = stepDone(i);
    const cls = ['step'];
    if (i === STATE.step) cls.push('active');
    if (done) cls.push('done');
    if (!unlocked) cls.push('locked');
    return `<div class="${cls.join(' ')}" data-step="${i}">
      <div class="n">${String(i).padStart(2, '0')}</div>
      <div class="t">${escapeHtml(s.title)}</div>
    </div>`;
  }).join('');
  el.querySelectorAll('.step').forEach(node => {
    node.addEventListener('click', () => {
      const idx = Number(node.dataset.step);
      if (stepUnlocked(idx)) goTo(idx);
      else toast('Conclua o passo anterior primeiro.', 'err');
    });
  });
}

function stepDone(idx) {
  switch (STEPS[idx].key) {
    case 'config': return STATE.jsonbin.connected;
    case 'cardex': return STATE.cardex.items.length > 0;
    case 'stock': return STATE.stock.items.length > 0;
    case 'vendas': return STATE.vendas.items.length > 0 || Object.keys(STATE.vendas.mediaPorArtigo || {}).length > 0;
    case 'pedido': return STATE.pedidoFinal.length > 0;
    case 'servico': return STATE.nivelServico.items.length > 0;
    case 'reforco': return STATE.reforco.length > 0;
    default: return false;
  }
}

// =================================================================
// ECRÃ 0 — Ligação de dados (JSONBin) + nome da loja + parâmetros
// =================================================================
function renderConfigScreen(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 0</span>
          <h2>Loja e parâmetros</h2>
          <p>O trabalho é guardado automaticamente na nuvem — pode continuar noutro computador ou amanhã sem fazer mais nada aqui.</p>
        </div>
      </div>

      <div class="grid2">
        <div>
          <div class="field-row">
            <label class="field">Nome da loja / armazém</label>
            <input type="text" id="inpStoreName" placeholder="Ex: Palanca" value="${escapeHtml(STATE.storeName)}">
          </div>
          <div id="connStatus"></div>
        </div>

        <div>
          <div class="field-row">
            <label class="field">Cobertura objetivo (dias)</label>
            <input type="number" id="inpCobertura" min="1" step="1" value="${STATE.config.coberturaObjDias}">
            <div class="help">Dias de stock que o pedido deve garantir: pedido = venda média diária × cobertura − stock atual.</div>
          </div>
          <div class="field-row">
            <label class="field">Janela de vendas para a média (dias)</label>
            <input type="number" id="inpJanela" min="1" step="1" value="${STATE.config.janelaVendasDias}">
            <div class="help">Por norma 10 dias, conforme pedido.</div>
          </div>
          <div class="field-row">
            <label class="field">Atenuação do reforço por categoria (0 a 1)</label>
            <input type="number" id="inpPeso" min="0" max="1" step="0.05" value="${STATE.config.pesoCategoriaReforco}">
            <div class="help">Quanto mais baixo, mais se reduz o reforço de artigos cuja categoria já está bem servida (evita excesso financeiro). 1 = sem atenuação.</div>
          </div>
          <div class="btn-row">
            <button class="btn" id="btnSaveParams">Guardar parâmetros</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Fluxo de trabalho</span>
          <h2>Como funciona</h2>
        </div>
      </div>
      <ol style="margin:0;padding-left:20px;font-size:13px;color:#4d4738;line-height:1.8;">
        <li><b>Cardex</b> — carregue a lista de artigos disponíveis para encomenda (define o universo de artigos elegíveis).</li>
        <li><b>Stock</b> — carregue o stock atual por artigo.</li>
        <li><b>Vendas</b> — carregue o histórico de vendas; a app calcula a venda média diária na janela configurada (10 dias por defeito) e sugere a quantidade a pedir por artigo.</li>
        <li><b>Pedido sugerido</b> — reveja, ajuste e exporte o pedido final.</li>
        <li><b>Nível de serviço</b> — carregue o que foi efetivamente servido face ao pedido. A app calcula a % de serviço por artigo.</li>
        <li><b>Reforço</b> — a app sugere um novo pedido de reforço para o que faltou, reduzindo o peso de artigos cuja categoria já está bem servida.</li>
      </ol>
    </div>

    ${STATE.jsonbin.connected ? `
    <div class="panel">
      <div class="panel-head">
        <div><span class="eyebrow">Manutenção</span><h2>Dados guardados</h2></div>
        <button class="btn danger small" id="btnResetAll">Repor tudo (apaga este ciclo)</button>
      </div>
      <div class="kv"><span>Cardex</span><b>${STATE.cardex.items.length} artigos</b></div>
      <div class="kv"><span>Stock</span><b>${STATE.stock.items.length} linhas</b></div>
      <div class="kv"><span>Vendas</span><b>${STATE.vendas.items.length ? STATE.vendas.items.length + ' linhas' : Object.keys(STATE.vendas.mediaPorArtigo || {}).length + ' artigos (só agregado)'}</b></div>
      <div class="kv"><span>Pedido aprovado</span><b>${STATE.pedidoFinal.length} artigos</b></div>
      <div class="kv"><span>Nível de serviço</span><b>${STATE.nivelServico.items.length} artigos</b></div>
      <div class="kv"><span>Reforço sugerido</span><b>${STATE.reforco.length} artigos</b></div>
    </div>` : ''}
  `;

  document.getElementById('btnSaveParams').addEventListener('click', () => {
    STATE.config.coberturaObjDias = Number(document.getElementById('inpCobertura').value) || 10;
    STATE.config.janelaVendasDias = Number(document.getElementById('inpJanela').value) || 10;
    STATE.config.pesoCategoriaReforco = Math.min(1, Math.max(0, Number(document.getElementById('inpPeso').value)));
    STATE.storeName = document.getElementById('inpStoreName').value.trim();
    scheduleCloudSave();
    toast('Parâmetros guardados.', 'ok');
    setStoreTag(STATE.storeName || (STATE.jsonbin.connected ? 'na nuvem' : 'sem ligação a dados'));
  });

  const resetBtn = document.getElementById('btnResetAll');
  if (resetBtn) resetBtn.addEventListener('click', onResetAll);
}

// Liga-se automaticamente à nuvem (via Worker) ao abrir a app — sem
// qualquer chave, ID ou URL pedido ao utilizador. Se já houver dados
// guardados remotamente, são carregados; caso contrário, o estado atual
// (eventualmente vazio) é gravado, servindo de ponto de partida.
async function connectCloud() {
  const statusEl = document.getElementById('connStatus');
  if (statusEl) statusEl.innerHTML = `<div class="banner info"><span class="spinner"></span> A ligar à nuvem…</div>`;
  try {
    const record = await cloudRead();
    if (record && Object.keys(record).length) {
      mergeRemoteState(record);
    } else {
      await cloudWrite(exportableState());
    }
    STATE.jsonbin.connected = true;
    setStoreTag(STATE.storeName || 'na nuvem', 'ok');
    saveLocal();
    if (statusEl) statusEl.innerHTML = `<div class="banner info">Ligado à nuvem. O trabalho é guardado automaticamente.</div>`;
    render();
  } catch (e) {
    STATE.jsonbin.connected = false;
    setStoreTag('sem ligação à nuvem', 'err');
    if (statusEl) {
      const friendly = /failed to fetch/i.test(e.message)
        ? 'Não foi possível contactar o servidor de dados. Verifique a ligação à internet e tente recarregar a página.'
        : e.message;
      statusEl.innerHTML = `<div class="banner danger">${escapeHtml(friendly)}</div>`;
    }
    toast('Sem ligação à nuvem — a trabalhar só neste navegador por agora.', 'err');
  }
}

function onResetAll() {
  if (!confirm('Isto apaga Cardex, Stock, Vendas, Pedido, Nível de Serviço e Reforço guardados. Continuar?')) return;
  STATE.cardex = { raw: null, fileName: '', mapping: {}, items: [] };
  STATE.stock = { raw: null, fileName: '', mapping: {}, items: [] };
  STATE.vendas = { raw: null, fileName: '', mapping: {}, items: [], periodoDias: 10 };
  STATE.pedidoSugerido = [];
  STATE.pedidoFinal = [];
  STATE.nivelServico = { raw: null, fileName: '', mapping: {}, items: [] };
  STATE.reforco = [];
  scheduleCloudSave();
  render();
  toast('Ciclo reposto.', 'ok');
}
/* ============================================================
   Componente genérico: Upload de Excel + Mapeamento de colunas
   Usado nos 4 ecrãs de carregamento (Cardex, Stock, Vendas, Serviço)
   ============================================================ */

// fieldDefs: [{ key, label, required, guesses:[strings parciais p/ auto-detetar], type:'text'|'number'|'date' }]
function renderUploadMapper({
  root, sectionState, fieldDefs, onParsed, dropzoneId, fileInputId,
  extraControlsHtml = '', extraControlsBind = () => {}
}) {
  const hasFile = !!sectionState.fileName;

  root.innerHTML += `
    <div class="dropzone" id="${dropzoneId}">
      <input type="file" id="${fileInputId}" accept=".xlsx,.xls,.csv">
      <div class="icon">⬆</div>
      <div class="label">Arraste o ficheiro Excel para aqui ou clique para escolher</div>
      <div class="hint">.xlsx, .xls ou .csv</div>
      ${hasFile ? `<div class="file-chip">📄 ${escapeHtml(sectionState.fileName)} <button type="button" id="btnClearFile_${fileInputId}">✕</button></div>` : ''}
    </div>
    <div id="mappingArea_${fileInputId}"></div>
    ${extraControlsHtml}
  `;

  const dz = document.getElementById(dropzoneId);
  const input = document.getElementById(fileInputId);
  dz.addEventListener('click', (e) => { if (e.target.id !== `btnClearFile_${fileInputId}`) input.click(); });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });

  const clearBtn = document.getElementById(`btnClearFile_${fileInputId}`);
  if (clearBtn) clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    Object.assign(sectionState, { raw: null, fileName: '', mapping: {}, items: [] });
    render();
  });

  extraControlsBind();

  async function handleFile(file) {
    try {
      const wb = await readWorkbookFile(file);
      const parsed = parseWorkbookFirstSheet(wb);
      if (!parsed.rows.length) { toast('O ficheiro parece estar vazio.', 'err'); return; }
      sectionState.fileName = file.name;
      sectionState.raw = parsed;
      sectionState.mapping = autoGuessMapping(parsed.headers, fieldDefs);
      renderMappingUI();
    } catch (err) {
      toast('Erro ao ler o ficheiro: ' + err.message, 'err');
    }
  }

  function renderMappingUI() {
    const area = document.getElementById(`mappingArea_${fileInputId}`);
    const headers = sectionState.raw.headers;
    area.innerHTML = `
      <div class="banner info">Ficheiro lido: <b>${sectionState.raw.rows.length}</b> linhas, <b>${headers.length}</b> colunas. Confirme o significado de cada coluna abaixo.</div>
      <div class="mapping-grid">
        ${fieldDefs.map(f => `
          <div>
            <label class="field">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
            <select data-fkey="${f.key}">
              <option value="">— não usar —</option>
              ${headers.map(h => `<option value="${escapeHtml(h)}" ${sectionState.mapping[f.key] === h ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
            </select>
          </div>
        `).join('')}
      </div>
      <div class="btn-row">
        <button class="btn accent" id="btnApplyMapping_${fileInputId}">Aplicar e processar</button>
        <span class="help" id="mappingWarn_${fileInputId}"></span>
      </div>
    `;
    area.querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', () => { sectionState.mapping[sel.dataset.fkey] = sel.value; });
    });
    document.getElementById(`btnApplyMapping_${fileInputId}`).addEventListener('click', () => {
      const missing = fieldDefs.filter(f => f.required && !sectionState.mapping[f.key]);
      if (missing.length) {
        document.getElementById(`mappingWarn_${fileInputId}`).innerHTML =
          `<span style="color:var(--danger)">Falta indicar: ${missing.map(m => m.label).join(', ')}</span>`;
        return;
      }
      onParsed();
    });
  }

  if (hasFile && sectionState.raw) renderMappingUI();
}

function autoGuessMapping(headers, fieldDefs) {
  const mapping = {};
  const normHeaders = headers.map(h => ({ raw: h, norm: normKey(h) }));
  for (const f of fieldDefs) {
    let found = '';
    for (const g of f.guesses) {
      const gNorm = normKey(g);
      const hit = normHeaders.find(h => h.norm === gNorm) || normHeaders.find(h => h.norm.includes(gNorm));
      if (hit) { found = hit.raw; break; }
    }
    if (found) mapping[f.key] = found;
  }
  return mapping;
}

// Converte linhas brutas (raw.rows) numa lista de objetos segundo o mapping e fieldDefs.
function applyMapping(rawRows, mapping, fieldDefs) {
  return rawRows.map(row => {
    const out = {};
    for (const f of fieldDefs) {
      const col = mapping[f.key];
      let val = col ? row[col] : '';
      if (f.type === 'number') val = toNum(val);
      else if (f.type === 'date') val = parseFlexibleDate(val);
      else val = String(val ?? '').trim();
      out[f.key] = val;
    }
    return out;
  });
}

function parseFlexibleDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    // serial Excel
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(d.y, d.m - 1, d.d);
  }
  const s = String(v).trim();
  // dd/mm/yyyy ou dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return new Date(Number(y), Number(mo) - 1, Number(d));
  }
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}
/* ============================================================
   ECRÃ 1 — Cardex (artigos disponíveis para pedido)
   ============================================================ */

const CARDEX_FIELDS = [
  { key: 'codigo', label: 'Código do artigo', required: true, type: 'text', guesses: ['Código artigo', 'Codigo', 'Código', 'SKU', 'Artigo'] },
  { key: 'descricao', label: 'Descrição', required: true, type: 'text', guesses: ['Descrição artigo', 'Descricao', 'Descrição', 'Nome'] },
  { key: 'categoria', label: 'Categoria (opcional)', required: false, type: 'text', guesses: ['Categoria', 'Família', 'Familia', 'Departamento'] },
  { key: 'unidade', label: 'Unidade a encomendar', required: false, type: 'text', guesses: ['Unidade a encomenda', 'Unidade', 'UN'] },
  { key: 'conversaoCaixas', label: 'Conversão / unidades por caixa', required: false, type: 'number', guesses: ['Conversão caixas', 'Conversao caixas', 'Unid/Caixa'] },
  { key: 'numeroDispo', label: 'Número de disponibilidade (opcional)', required: false, type: 'number', guesses: ['Numero Dispo', 'Número Dispo'] },
];

function renderCardexScreen(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 1</span>
          <h2>Cardex — artigos disponíveis</h2>
          <p>Carregue o ficheiro com a lista de artigos que podem ser encomendados. Apenas estes artigos entrarão na sugestão de pedido. Se o ficheiro não tiver uma coluna de categoria, a app deriva uma a partir da primeira palavra da descrição.</p>
        </div>
      </div>
      <div id="cardexUploadWrap"></div>
    </div>
    <div id="cardexTableWrap"></div>
  `;

  renderUploadMapper({
    root: document.getElementById('cardexUploadWrap'),
    sectionState: STATE.cardex,
    fieldDefs: CARDEX_FIELDS,
    dropzoneId: 'dzCardex',
    fileInputId: 'fileCardex',
    onParsed: () => {
      const items = applyMapping(STATE.cardex.raw.rows, STATE.cardex.mapping, CARDEX_FIELDS)
        .filter(r => r.codigo)
        .map(r => ({
          ...r,
          categoria: r.categoria || deriveCategoryFromDescription(r.descricao),
          conversaoCaixas: r.conversaoCaixas > 0 ? r.conversaoCaixas : 1,
        }));
      STATE.cardex.items = items;
      scheduleCloudSave();
      toast(`Cardex carregado: ${items.length} artigos.`, 'ok');
      render();
    }
  });

  renderCardexTable(document.getElementById('cardexTableWrap'));
}

function deriveCategoryFromDescription(desc) {
  if (!desc) return '—';
  return String(desc).trim().split(/\s+/)[0];
}

function categoriaFragmentationWarning(items) {
  const counts = {};
  items.forEach(i => counts[i.categoria] = (counts[i.categoria] || 0) + 1);
  const cats = Object.keys(counts);
  const singles = cats.filter(c => counts[c] === 1).length;
  const ratio = cats.length ? singles / cats.length : 0;
  return { cats, singles, ratio, hasColumn: !!STATE.cardex.mapping.categoria };
}

function renderCardexTable(container) {
  const items = STATE.cardex.items;
  if (!items.length) {
    container.innerHTML = `<div class="panel"><div class="empty"><div class="big">📋</div>Ainda sem artigos carregados.</div></div>`;
    return;
  }
  const cats = [...new Set(items.map(i => i.categoria))].sort();
  const frag = categoriaFragmentationWarning(items);

  container.innerHTML = `
    <div class="panel">
      ${(!frag.hasColumn && frag.ratio > 0.3) ? `
        <div class="banner warn">
          ⚠ O ficheiro não tinha coluna de categoria, por isso foi derivada a partir da 1ª palavra da descrição.
          <b>${frag.singles} de ${frag.cats.length}</b> categorias têm apenas 1 artigo — isto reduz a eficácia do critério de reforço
          "mesma categoria" no passo 6. Edite a categoria diretamente na tabela (clique e escreva) para agrupar artigos relacionados,
          ou recarregue o ficheiro mapeando uma coluna de categoria real, se existir.
        </div>` : ''}
      <div class="toolbar">
        <div class="search-box">🔎 <input type="text" id="cardexSearch" placeholder="Procurar código ou descrição…"></div>
        <div>
          <select id="cardexCatFilter" style="width:auto;">
            <option value="">Todas as categorias (${cats.length})</option>
            ${cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${items.length}</div><div class="l">Artigos no cardex</div></div>
        <div class="stat"><div class="v">${cats.length}</div><div class="l">Categorias</div></div>
        <div class="stat"><div class="v">${frag.singles}</div><div class="l">Categorias com 1 só artigo</div></div>
      </div>
      <div class="help" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>Dica: clique numa categoria na tabela para editar e agrupar artigos semelhantes (ex: unificar "Vinho" e "Vinhos").</span>
        <button class="btn small secondary" id="btnMergeCats">Fundir duas categorias…</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Código</th><th>Descrição</th><th>Categoria (editável)</th><th>Unidade</th><th class="num">Unid/Caixa</th>
        </tr></thead>
        <tbody id="cardexTbody"></tbody>
      </table></div>
    </div>
  `;
  const tbody = container.querySelector('#cardexTbody');
  function draw() {
    const q = normKey(document.getElementById('cardexSearch').value);
    const cat = document.getElementById('cardexCatFilter').value;
    const rows = items.filter(it =>
      (!q || normKey(it.codigo).includes(q) || normKey(it.descricao).includes(q)) &&
      (!cat || it.categoria === cat)
    );
    tbody.innerHTML = rows.map(it => `
      <tr data-code="${escapeHtml(it.codigo)}">
        <td>${escapeHtml(it.codigo)}</td>
        <td>${escapeHtml(it.descricao)}</td>
        <td><span class="editable cat-edit" contenteditable="true" data-code="${escapeHtml(it.codigo)}">${escapeHtml(it.categoria)}</span></td>
        <td>${escapeHtml(it.unidade || '—')}</td>
        <td class="num">${fmtNum(it.conversaoCaixas)}</td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="text-align:center;color:#8a8374;">Sem resultados.</td></tr>`;

    tbody.querySelectorAll('.cat-edit').forEach(el => {
      el.addEventListener('blur', () => {
        const code = el.dataset.code;
        const it = items.find(i => i.codigo === code);
        const newVal = el.textContent.trim() || '—';
        if (it && it.categoria !== newVal) {
          it.categoria = newVal;
          scheduleCloudSave();
        }
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      });
    });
  }
  container.querySelector('#cardexSearch').addEventListener('input', draw);
  container.querySelector('#cardexCatFilter').addEventListener('change', () => { draw(); });
  draw();

  document.getElementById('btnMergeCats').addEventListener('click', () => {
    const from = prompt('Categoria de origem (será substituída) — escreva exatamente como aparece:');
    if (!from) return;
    const exists = items.some(i => i.categoria === from);
    if (!exists) { toast('Categoria não encontrada: ' + from, 'err'); return; }
    const to = prompt(`Fundir "${from}" em qual categoria de destino?`);
    if (!to) return;
    let count = 0;
    items.forEach(i => { if (i.categoria === from) { i.categoria = to.trim(); count++; } });
    scheduleCloudSave();
    toast(`${count} artigo(s) movido(s) de "${from}" para "${to}".`, 'ok');
    renderCardexTable(container);
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  btnRow.innerHTML = `<button class="btn accent" id="btnGoStock">Avançar para Stock →</button>`;
  container.querySelector('.panel').appendChild(btnRow);
  document.getElementById('btnGoStock').addEventListener('click', () => {
    scheduleCloudSave();
    goTo(2);
  });
}
/* ============================================================
   ECRÃ 2 — Stock atual
   ============================================================ */

const STOCK_FIELDS = [
  { key: 'codigo', label: 'Código do artigo', required: true, type: 'text', guesses: ['Código artigo', 'Codigo', 'Código', 'SKU', 'Artigo'] },
  { key: 'descricao', label: 'Descrição (opcional)', required: false, type: 'text', guesses: ['Descrição', 'Descricao', 'Nome'] },
  { key: 'quantidade', label: 'Quantidade em stock', required: true, type: 'number', guesses: ['Stock', 'Quantidade', 'Qtd', 'Stock Atual', 'Existências', 'Existencias'] },
];

function renderStockScreen(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 2</span>
          <h2>Stock atual</h2>
          <p>Carregue o ficheiro de stock por artigo. Será usado para calcular quanto falta pedir face à venda média e à cobertura objetivo.</p>
        </div>
      </div>
      <div id="stockUploadWrap"></div>
    </div>
    <div id="stockTableWrap"></div>
  `;

  renderUploadMapper({
    root: document.getElementById('stockUploadWrap'),
    sectionState: STATE.stock,
    fieldDefs: STOCK_FIELDS,
    dropzoneId: 'dzStock',
    fileInputId: 'fileStock',
    onParsed: () => {
      const items = applyMapping(STATE.stock.raw.rows, STATE.stock.mapping, STOCK_FIELDS).filter(r => r.codigo);
      STATE.stock.items = items;
      scheduleCloudSave();
      toast(`Stock carregado: ${items.length} linhas.`, 'ok');
      render();
    }
  });

  renderStockTable(document.getElementById('stockTableWrap'));
}

function renderStockTable(container) {
  const items = STATE.stock.items;
  if (!items.length) {
    container.innerHTML = `<div class="panel"><div class="empty"><div class="big">📦</div>Ainda sem stock carregado.</div></div>`;
    return;
  }
  const cardexCodes = new Set(STATE.cardex.items.map(c => normKey(c.codigo)));
  const foraDoCardex = items.filter(it => !cardexCodes.has(normKey(it.codigo))).length;
  const totalUnid = items.reduce((s, i) => s + i.quantidade, 0);

  container.innerHTML = `
    <div class="panel">
      ${foraDoCardex > 0 ? `<div class="banner warn">⚠ ${foraDoCardex} artigo(s) no ficheiro de stock não constam do Cardex e serão ignorados na sugestão de pedido.</div>` : ''}
      <div class="toolbar">
        <div class="search-box">🔎 <input type="text" id="stockSearch" placeholder="Procurar código…"></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${items.length}</div><div class="l">Linhas de stock</div></div>
        <div class="stat"><div class="v">${fmtNum(totalUnid)}</div><div class="l">Unidades totais</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Código</th><th>Descrição</th><th class="num">Quantidade</th><th>No Cardex?</th></tr></thead>
        <tbody id="stockTbody"></tbody>
      </table></div>
    </div>
  `;
  const tbody = container.querySelector('#stockTbody');
  function draw() {
    const q = normKey(document.getElementById('stockSearch').value);
    const rows = items.filter(it => !q || normKey(it.codigo).includes(q) || normKey(it.descricao).includes(q));
    tbody.innerHTML = rows.map(it => {
      const inCardex = cardexCodes.has(normKey(it.codigo));
      return `<tr>
        <td>${escapeHtml(it.codigo)}</td>
        <td>${escapeHtml(it.descricao || '—')}</td>
        <td class="num">${fmtNum(it.quantidade)}</td>
        <td>${inCardex ? '<span class="tag ok">sim</span>' : '<span class="tag warn">não</span>'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="4" style="text-align:center;color:#8a8374;">Sem resultados.</td></tr>`;
  }
  container.querySelector('#stockSearch').addEventListener('input', draw);
  draw();

  const btnRow = document.createElement('div');
  btnRow.className = 'btn-row';
  btnRow.innerHTML = `<button class="btn secondary" id="btnBackCardex">← Cardex</button>
    <button class="btn accent" id="btnGoVendas">Avançar para Vendas →</button>`;
  container.querySelector('.panel').appendChild(btnRow);
  document.getElementById('btnBackCardex').addEventListener('click', () => goTo(1));
  document.getElementById('btnGoVendas').addEventListener('click', () => goTo(3));
}
/* ============================================================
   ECRÃ 3 — Vendas (histórico) → cálculo da venda média diária
   ============================================================ */

const VENDAS_FIELDS = [
  { key: 'codigo', label: 'Código do artigo', required: true, type: 'text', guesses: ['Código artigo', 'Codigo', 'Código', 'SKU', 'Artigo'] },
  { key: 'descricao', label: 'Descrição (opcional)', required: false, type: 'text', guesses: ['Descrição', 'Descricao', 'Nome'] },
  { key: 'data', label: 'Data da venda', required: true, type: 'date', guesses: ['Data', 'Data Venda', 'Dia'] },
  { key: 'quantidade', label: 'Quantidade vendida', required: true, type: 'number', guesses: ['Quantidade', 'Qtd', 'Vendas', 'Qtd Vendida', 'Unidades'] },
];

function renderVendasScreen(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 3</span>
          <h2>Vendas</h2>
          <p>Carregue o histórico de vendas (uma linha por artigo/data, ou totais diários). A app calcula a venda média diária dos últimos ${STATE.config.janelaVendasDias} dias com base na data mais recente do ficheiro.</p>
        </div>
      </div>
      <div id="vendasUploadWrap"></div>
    </div>
    <div id="vendasTableWrap"></div>
  `;

  renderUploadMapper({
    root: document.getElementById('vendasUploadWrap'),
    sectionState: STATE.vendas,
    fieldDefs: VENDAS_FIELDS,
    dropzoneId: 'dzVendas',
    fileInputId: 'fileVendas',
    onParsed: () => {
      const items = applyMapping(STATE.vendas.raw.rows, STATE.vendas.mapping, VENDAS_FIELDS)
        .filter(r => r.codigo && r.data);
      STATE.vendas.items = items;
      scheduleCloudSave();
      toast(`Vendas carregadas: ${items.length} linhas.`, 'ok');
      render();
    }
  });

  renderVendasTable(document.getElementById('vendasTableWrap'));
}

function renderVendasTable(container) {
  const items = STATE.vendas.items;
  const restoredAgg = STATE.vendas.mediaPorArtigo && Object.keys(STATE.vendas.mediaPorArtigo).length > 0;

  if (!items.length && !restoredAgg) {
    container.innerHTML = `<div class="panel"><div class="empty"><div class="big">📈</div>Ainda sem vendas carregadas.</div></div>`;
    return;
  }

  let mediaPorArtigo, dataLimite, dataMax, janelaLabel;
  if (items.length) {
    const calc = calcularVendaMedia(items, STATE.config.janelaVendasDias);
    mediaPorArtigo = calc.mediaPorArtigo; dataLimite = calc.dataLimite; dataMax = calc.dataMax;
    janelaLabel = `${dataLimite.toLocaleDateString('pt-PT')} a ${dataMax.toLocaleDateString('pt-PT')}`;
  } else {
    mediaPorArtigo = STATE.vendas.mediaPorArtigo;
    janelaLabel = null;
  }

  const cardexCodes = new Set(STATE.cardex.items.map(c => normKey(c.codigo)));
  const cobertos = STATE.cardex.items.filter(c => mediaPorArtigo[normKey(c.codigo)] > 0).length;

  container.innerHTML = `
    <div class="panel">
      ${items.length ? `
        <div class="banner info">
          Janela considerada: <b>${janelaLabel}</b> (${STATE.config.janelaVendasDias} dias). Pode ajustar a janela no passo 0.
        </div>` : `
        <div class="banner warn">
          ⚠ Este ciclo foi restaurado da nuvem: apenas a <b>venda média por artigo</b> foi guardada (o detalhe diário não é persistido no JSONBin para manter o ficheiro dentro do limite de 1MB).
          Pode prosseguir normalmente para o pedido com os valores já calculados, ou recarregar o ficheiro de vendas se quiser alterar a janela.
        </div>`}
      <div class="stats">
        <div class="stat"><div class="v">${items.length || '—'}</div><div class="l">Linhas de venda</div></div>
        <div class="stat"><div class="v">${Object.keys(mediaPorArtigo).length}</div><div class="l">Artigos com venda na janela</div></div>
        <div class="stat"><div class="v">${cobertos}/${STATE.cardex.items.length}</div><div class="l">Artigos do Cardex com histórico</div></div>
      </div>
      <div class="toolbar">
        <div class="search-box">🔎 <input type="text" id="vendasSearch" placeholder="Procurar código…"></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Código</th><th>Descrição</th><th class="num">Venda média/dia (${STATE.config.janelaVendasDias}d)</th><th class="num">Total no período</th></tr></thead>
        <tbody id="vendasTbody"></tbody>
      </table></div>
      <div class="btn-row">
        <button class="btn secondary" id="btnBackStock">← Stock</button>
        <button class="btn accent" id="btnCalcPedido">Calcular pedido sugerido →</button>
      </div>
    </div>
  `;

  const tbody = container.querySelector('#vendasTbody');
  const cardexByCode = {};
  STATE.cardex.items.forEach(c => cardexByCode[normKey(c.codigo)] = c);

  function draw() {
    const q = normKey(document.getElementById('vendasSearch').value);
    const codes = Object.keys(mediaPorArtigo).filter(k => !q || k.includes(q));
    const rows = codes.map(k => {
      const cx = cardexByCode[k];
      const desc = cx ? cx.descricao : (items.find(i => normKey(i.codigo) === k)?.descricao || '');
      return { codigo: cx ? cx.codigo : k, desc, media: mediaPorArtigo[k] };
    }).sort((a, b) => b.media - a.media);

    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.codigo)}</td>
        <td>${escapeHtml(r.desc || '—')}</td>
        <td class="num">${fmtNum(r.media, 2)}</td>
        <td class="num">${fmtNum(r.media * STATE.config.janelaVendasDias, 1)}</td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="text-align:center;color:#8a8374;">Sem resultados.</td></tr>`;
  }
  container.querySelector('#vendasSearch').addEventListener('input', draw);
  draw();

  document.getElementById('btnBackStock').addEventListener('click', () => goTo(2));
  document.getElementById('btnCalcPedido').addEventListener('click', () => {
    STATE.pedidoSugerido = gerarPedidoSugerido({
      cardex: STATE.cardex.items,
      stock: STATE.stock.items,
      mediaPorArtigo,
      coberturaDias: STATE.config.coberturaObjDias,
    });
    STATE.pedidoFinal = STATE.pedidoSugerido.map(p => ({ ...p }));
    scheduleCloudSave();
    goTo(4);
  });
}
/* ============================================================
   ECRÃ 4 — Pedido sugerido (editável, aprovação e exportação)
   ============================================================ */

function renderPedidoScreen(root) {
  if (!STATE.pedidoFinal.length) {
    root.innerHTML = `<div class="panel"><div class="empty"><div class="big">🧮</div>Ainda não foi calculado nenhum pedido. Conclua o passo de Vendas primeiro.</div></div>`;
    return;
  }

  const items = STATE.pedidoFinal;
  const aPedir = items.filter(i => i.qtdPedida > 0);
  const cats = [...new Set(items.map(i => i.categoria))].sort();
  const totalCaixas = aPedir.reduce((s, i) => s + Math.ceil(i.qtdPedida / (i.conversaoCaixas || 1)), 0);
  const totalUnid = aPedir.reduce((s, i) => s + i.qtdPedida, 0);
  const semCobertura = items.filter(i => i.coberturaDiasAtual === 0 && i.vendaMediaDia === 0).length;

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 4</span>
          <h2>Pedido sugerido</h2>
          <p>Pedido = venda média diária × ${STATE.config.coberturaObjDias} dias de cobertura − stock atual, arredondado para a unidade de caixa. Pode editar a coluna <b>Qtd a pedir</b> diretamente na tabela antes de aprovar.</p>
        </div>
      </div>

      <div class="stats">
        <div class="stat"><div class="v">${aPedir.length}</div><div class="l">Artigos com pedido</div></div>
        <div class="stat"><div class="v">${fmtNum(totalUnid)}</div><div class="l">Unidades a pedir</div></div>
        <div class="stat"><div class="v">${fmtNum(totalCaixas)}</div><div class="l">Caixas a pedir (aprox.)</div></div>
        <div class="stat"><div class="v">${semCobertura}</div><div class="l">Artigos sem histórico de venda</div></div>
      </div>

      <div class="toolbar">
        <div class="search-box">🔎 <input type="text" id="pedSearch" placeholder="Procurar código ou descrição…"></div>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="pedCatFilter" style="width:auto;">
            <option value="">Todas as categorias</option>
            ${cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;">
            <input type="checkbox" id="pedOnlyPositive" checked style="width:auto;"> só com pedido > 0
          </label>
        </div>
      </div>

      <div class="table-wrap"><table>
        <thead><tr>
          <th>Código</th><th>Descrição</th><th>Categoria</th>
          <th class="num">Venda média/dia</th><th class="num">Stock atual</th><th class="num">Cobertura atual (dias)</th>
          <th class="num">Sugestão</th><th class="num">Qtd a pedir</th>
        </tr></thead>
        <tbody id="pedTbody"></tbody>
      </table></div>

      <div class="legend">
        <span><span class="swatch" style="background:var(--danger)"></span> cobertura &lt; 3 dias</span>
        <span><span class="swatch" style="background:var(--warn)"></span> cobertura &lt; ${STATE.config.coberturaObjDias} dias</span>
        <span><span class="swatch" style="background:var(--ok)"></span> cobertura ok</span>
      </div>

      <div class="btn-row">
        <button class="btn secondary" id="btnBackVendas">← Vendas</button>
        <button class="btn" id="btnRecalc">Recalcular sugestão (descarta edições)</button>
        <button class="btn" id="btnExportXlsx">⬇ Exportar .xlsx</button>
        <button class="btn" id="btnExportCsv">⬇ Exportar .csv</button>
        <button class="btn accent" id="btnApprovePedido">Aprovar pedido e avançar →</button>
      </div>
    </div>
  `;

  const tbody = root.querySelector('#pedTbody');

  function rowsFiltered() {
    const q = normKey(document.getElementById('pedSearch').value);
    const cat = document.getElementById('pedCatFilter').value;
    const onlyPos = document.getElementById('pedOnlyPositive').checked;
    return items.filter(it =>
      (!q || normKey(it.codigo).includes(q) || normKey(it.descricao).includes(q)) &&
      (!cat || it.categoria === cat) &&
      (!onlyPos || it.qtdPedida > 0)
    );
  }

  function coberturaTag(it) {
    const cob = it.qtdPedida > 0 || it.vendaMediaDia > 0 ? it.coberturaDiasAtual : null;
    if (cob === null || cob === Infinity) return '<span class="tag muted">s/ venda</span>';
    if (cob < 3) return `<span class="tag danger">${fmtNum(cob, 1)}</span>`;
    if (cob < STATE.config.coberturaObjDias) return `<span class="tag warn">${fmtNum(cob, 1)}</span>`;
    return `<span class="tag ok">${fmtNum(cob, 1)}</span>`;
  }

  function draw() {
    const rows = rowsFiltered();
    tbody.innerHTML = rows.map(it => `
      <tr data-code="${escapeHtml(it.codigo)}">
        <td>${escapeHtml(it.codigo)}</td>
        <td>${escapeHtml(it.descricao)}</td>
        <td><span class="tag muted">${escapeHtml(it.categoria)}</span></td>
        <td class="num">${fmtNum(it.vendaMediaDia, 2)}</td>
        <td class="num">${fmtNum(it.stockAtual)}</td>
        <td class="num">${coberturaTag(it)}</td>
        <td class="num">${fmtNum(it.qtdSugerida)}</td>
        <td class="num"><input type="number" min="0" step="${it.conversaoCaixas || 1}" class="editable-qty" data-code="${escapeHtml(it.codigo)}" value="${it.qtdPedida}" style="width:90px;text-align:right;padding:4px 6px;"></td>
      </tr>
    `).join('') || `<tr><td colspan="8" style="text-align:center;color:#8a8374;">Sem resultados.</td></tr>`;

    tbody.querySelectorAll('.editable-qty').forEach(inp => {
      inp.addEventListener('change', () => {
        const code = inp.dataset.code;
        const it = items.find(i => i.codigo === code);
        const v = Math.max(0, Number(inp.value) || 0);
        it.qtdPedida = v;
        inp.value = v;
        scheduleCloudSave();
      });
    });
  }

  ['pedSearch', 'pedCatFilter', 'pedOnlyPositive'].forEach(id =>
    root.querySelector('#' + id).addEventListener('input', draw)
  );
  draw();

  document.getElementById('btnBackVendas').addEventListener('click', () => goTo(3));
  document.getElementById('btnRecalc').addEventListener('click', () => {
    if (!confirm('Isto substitui as quantidades editadas pela sugestão original. Continuar?')) return;
    const { mediaPorArtigo } = calcularVendaMedia(STATE.vendas.items, STATE.config.janelaVendasDias);
    STATE.pedidoSugerido = gerarPedidoSugerido({
      cardex: STATE.cardex.items, stock: STATE.stock.items, mediaPorArtigo,
      coberturaDias: STATE.config.coberturaObjDias,
    });
    STATE.pedidoFinal = STATE.pedidoSugerido.map(p => ({ ...p }));
    scheduleCloudSave();
    render();
    toast('Sugestão recalculada.', 'ok');
  });

  document.getElementById('btnExportXlsx').addEventListener('click', () => {
    const rows = aPedirRows();
    downloadXLSX('pedido_sugerido.xlsx',
      ['Código', 'Descrição', 'Categoria', 'Unidade', 'Unid/Caixa', 'Venda média/dia', 'Stock atual', 'Qtd a pedir', 'Caixas a pedir'],
      rows);
    toast('Exportado pedido_sugerido.xlsx', 'ok');
  });
  document.getElementById('btnExportCsv').addEventListener('click', () => {
    const rows = aPedirRows();
    downloadCSV('pedido_sugerido.csv',
      ['Código', 'Descrição', 'Categoria', 'Unidade', 'Unid/Caixa', 'Venda média/dia', 'Stock atual', 'Qtd a pedir', 'Caixas a pedir'],
      rows);
    toast('Exportado pedido_sugerido.csv', 'ok');
  });

  function aPedirRows() {
    return items.filter(i => i.qtdPedida > 0).map(i => [
      i.codigo, i.descricao, i.categoria, i.unidade || '', i.conversaoCaixas,
      Number(i.vendaMediaDia.toFixed(2)), i.stockAtual, i.qtdPedida, Math.ceil(i.qtdPedida / (i.conversaoCaixas || 1))
    ]);
  }

  document.getElementById('btnApprovePedido').addEventListener('click', () => {
    STATE.history.push({ tipo: 'pedido', data: new Date().toISOString(), itens: JSON.parse(JSON.stringify(STATE.pedidoFinal)) });
    scheduleCloudSave();
    toast('Pedido aprovado. Pode agora carregar o nível de serviço.', 'ok');
    goTo(5);
  });
}
/* ============================================================
   ECRÃ 5 — Nível de serviço (pedido vs. servido)
   ============================================================ */

const SERVICO_FIELDS = [
  { key: 'codigo', label: 'Código do artigo', required: true, type: 'text', guesses: ['Código artigo', 'Codigo', 'Código', 'SKU', 'Artigo'] },
  { key: 'descricao', label: 'Descrição (opcional)', required: false, type: 'text', guesses: ['Descrição', 'Descricao'] },
  { key: 'quantidade', label: 'Quantidade servida', required: true, type: 'number', guesses: ['Servido', 'Quantidade Servida', 'Qtd Servida', 'Entregue', 'Recebido'] },
];

function renderServicoScreen(root) {
  if (!STATE.pedidoFinal.some(i => i.qtdPedida > 0)) {
    root.innerHTML = `<div class="panel"><div class="empty"><div class="big">🚚</div>Aprove primeiro um pedido no passo 4.</div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 5</span>
          <h2>Nível de serviço</h2>
          <p>Carregue o ficheiro com a quantidade efetivamente servida por artigo face ao pedido aprovado. A app calcula a % de serviço e a falta de entrega por artigo.</p>
        </div>
      </div>
      <div id="servicoUploadWrap"></div>
    </div>
    <div id="servicoTableWrap"></div>
  `;

  renderUploadMapper({
    root: document.getElementById('servicoUploadWrap'),
    sectionState: STATE.nivelServico,
    fieldDefs: SERVICO_FIELDS,
    dropzoneId: 'dzServico',
    fileInputId: 'fileServico',
    onParsed: () => {
      const servidoItems = applyMapping(STATE.nivelServico.raw.rows, STATE.nivelServico.mapping, SERVICO_FIELDS)
        .filter(r => r.codigo);
      STATE.nivelServico.items = calcularNivelServico(STATE.pedidoFinal, servidoItems);
      scheduleCloudSave();
      toast(`Nível de serviço calculado para ${STATE.nivelServico.items.length} artigos.`, 'ok');
      render();
    }
  });

  renderServicoTable(document.getElementById('servicoTableWrap'));
}

function renderServicoTable(container) {
  const items = STATE.nivelServico.items;
  if (!items.length) {
    container.innerHTML = `<div class="panel"><div class="empty"><div class="big">📊</div>Ainda sem dados de nível de serviço.</div></div>`;
    return;
  }

  const conhecidos = items.filter(i => i.servidoConhecido);
  const semDado = items.length - conhecidos.length;
  const nivelMedio = conhecidos.length ? conhecidos.reduce((s, i) => s + i.nivelServico, 0) / conhecidos.length : 0;
  const totalFalta = items.reduce((s, i) => s + i.faltaEntregar, 0);
  const cats = [...new Set(items.map(i => i.categoria))].sort();

  container.innerHTML = `
    <div class="panel">
      ${semDado > 0 ? `<div class="banner warn">⚠ ${semDado} artigo(s) do pedido não aparecem no ficheiro de servido — assumidos como 0 servido.</div>` : ''}
      <div class="stats">
        <div class="stat"><div class="v">${fmtPct(nivelMedio)}</div><div class="l">Nível de serviço médio</div></div>
        <div class="stat"><div class="v">${items.filter(i => i.nivelServico !== null && i.nivelServico < 1).length}</div><div class="l">Artigos com falta</div></div>
        <div class="stat"><div class="v">${fmtNum(totalFalta)}</div><div class="l">Unidades em falta</div></div>
      </div>
      <div class="toolbar">
        <div class="search-box">🔎 <input type="text" id="svSearch" placeholder="Procurar código ou descrição…"></div>
        <select id="svCatFilter" style="width:auto;">
          <option value="">Todas as categorias</option>
          ${cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Código</th><th>Descrição</th><th>Categoria</th>
          <th class="num">Pedido</th><th class="num">Servido</th><th class="num">Nível</th><th class="num">Falta</th>
        </tr></thead>
        <tbody id="svTbody"></tbody>
      </table></div>
      <div class="btn-row">
        <button class="btn secondary" id="btnBackPedido">← Pedido</button>
        <button class="btn accent" id="btnGoReforco">Gerar sugestão de reforço →</button>
      </div>
    </div>
  `;

  const tbody = container.querySelector('#svTbody');
  function nivelTag(n) {
    if (n === null) return '<span class="tag muted">s/ dado</span>';
    if (n >= 1) return `<span class="tag ok">${fmtPct(n)}</span>`;
    if (n >= 0.7) return `<span class="tag warn">${fmtPct(n)}</span>`;
    return `<span class="tag danger">${fmtPct(n)}</span>`;
  }
  function draw() {
    const q = normKey(document.getElementById('svSearch').value);
    const cat = document.getElementById('svCatFilter').value;
    const rows = items
      .filter(it => (!q || normKey(it.codigo).includes(q) || normKey(it.descricao).includes(q)) && (!cat || it.categoria === cat))
      .sort((a, b) => b.faltaEntregar - a.faltaEntregar);
    tbody.innerHTML = rows.map(it => `
      <tr>
        <td>${escapeHtml(it.codigo)}</td>
        <td>${escapeHtml(it.descricao)}</td>
        <td><span class="tag muted">${escapeHtml(it.categoria)}</span></td>
        <td class="num">${fmtNum(it.qtdPedida)}</td>
        <td class="num">${fmtNum(it.qtdServida)}</td>
        <td class="num">${nivelTag(it.nivelServico)}</td>
        <td class="num">${it.faltaEntregar > 0 ? fmtNum(it.faltaEntregar) : '—'}</td>
      </tr>
    `).join('') || `<tr><td colspan="7" style="text-align:center;color:#8a8374;">Sem resultados.</td></tr>`;
  }
  container.querySelector('#svSearch').addEventListener('input', draw);
  container.querySelector('#svCatFilter').addEventListener('change', draw);
  draw();

  document.getElementById('btnBackPedido').addEventListener('click', () => goTo(4));
  document.getElementById('btnGoReforco').addEventListener('click', () => {
    STATE.reforco = gerarSugestaoReforco(STATE.nivelServico.items, {
      pesoCategoria: STATE.config.pesoCategoriaReforco,
    });
    scheduleCloudSave();
    goTo(6);
  });
}
/* ============================================================
   ECRÃ 6 — Sugestão de reforço (novo pedido)
   ============================================================ */

function renderReforcoScreen(root) {
  if (!STATE.nivelServico.items.length) {
    root.innerHTML = `<div class="panel"><div class="empty"><div class="big">🔁</div>Carregue primeiro o nível de serviço no passo 5.</div></div>`;
    return;
  }
  if (!STATE.reforco.length) {
    STATE.reforco = gerarSugestaoReforco(STATE.nivelServico.items, { pesoCategoria: STATE.config.pesoCategoriaReforco });
  }

  const items = STATE.reforco;
  const cats = [...new Set(items.map(i => i.categoria))].sort();
  const totalReforco = items.reduce((s, i) => s + i.qtdReforco, 0);
  const totalCaixas = items.reduce((s, i) => s + Math.ceil(i.qtdReforco / (i.conversaoCaixas || 1)), 0);
  const atenuados = items.filter(i => i.fatorAtenuacao < 0.99).length;

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Passo 6</span>
          <h2>Sugestão de reforço</h2>
          <p>Reforça artigos com falta de entrega face ao pedido. Quando outros artigos da <b>mesma categoria</b> já tiveram bom nível de serviço (≥ 95%), o reforço é atenuado para reduzir o risco de excesso de stock financeiro nessa categoria. Atenuação atual: <b>${fmtPct(1 - STATE.config.pesoCategoriaReforco)}</b> no máximo (parâmetro do passo 0).</p>
        </div>
      </div>

      <div class="stats">
        <div class="stat"><div class="v">${items.length}</div><div class="l">Artigos a reforçar</div></div>
        <div class="stat"><div class="v">${fmtNum(totalReforco)}</div><div class="l">Unidades de reforço</div></div>
        <div class="stat"><div class="v">${fmtNum(totalCaixas)}</div><div class="l">Caixas (aprox.)</div></div>
        <div class="stat"><div class="v">${atenuados}</div><div class="l">Artigos com reforço atenuado</div></div>
      </div>

      <div class="toolbar">
        <div class="search-box">🔎 <input type="text" id="rfSearch" placeholder="Procurar código ou descrição…"></div>
        <select id="rfCatFilter" style="width:auto;">
          <option value="">Todas as categorias</option>
          ${cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>

      <div class="table-wrap"><table>
        <thead><tr>
          <th>Código</th><th>Descrição</th><th>Categoria</th>
          <th class="num">Pedido orig.</th><th class="num">Servido</th><th class="num">Falta</th>
          <th class="num">Nível médio categoria</th><th class="num">Atenuação</th>
          <th>Prioridade</th><th class="num">Reforço sugerido</th><th class="num">Reforço final</th>
        </tr></thead>
        <tbody id="rfTbody"></tbody>
      </table></div>

      <div class="legend">
        <span><span class="swatch" style="background:var(--danger)"></span> prioridade alta — categoria ainda com falhas</span>
        <span><span class="swatch" style="background:var(--warn)"></span> prioridade média — atenuado parcialmente</span>
        <span><span class="swatch" style="background:#9a9484"></span> prioridade baixa — categoria já bem servida</span>
      </div>

      <div class="btn-row">
        <button class="btn secondary" id="btnBackServico">← Nível de serviço</button>
        <button class="btn" id="btnRecalcReforco">Recalcular (descarta edições)</button>
        <button class="btn" id="btnExportReforcoXlsx">⬇ Exportar .xlsx</button>
        <button class="btn" id="btnExportReforcoCsv">⬇ Exportar .csv</button>
        <button class="btn accent" id="btnNovoCiclo">Aprovar reforço e iniciar novo ciclo</button>
      </div>
    </div>
  `;

  const tbody = root.querySelector('#rfTbody');
  function prioTag(p) {
    return p === 'alta' ? '<span class="tag danger">alta</span>' :
           p === 'media' ? '<span class="tag warn">média</span>' :
           '<span class="tag muted">baixa</span>';
  }
  function draw() {
    const q = normKey(document.getElementById('rfSearch').value);
    const cat = document.getElementById('rfCatFilter').value;
    const rows = items.filter(it =>
      (!q || normKey(it.codigo).includes(q) || normKey(it.descricao).includes(q)) &&
      (!cat || it.categoria === cat)
    );
    tbody.innerHTML = rows.map(it => `
      <tr data-code="${escapeHtml(it.codigo)}">
        <td>${escapeHtml(it.codigo)}</td>
        <td>${escapeHtml(it.descricao)}</td>
        <td><span class="tag muted">${escapeHtml(it.categoria)}</span></td>
        <td class="num">${fmtNum(it.qtdPedidaOriginal)}</td>
        <td class="num">${fmtNum(it.qtdServida)}</td>
        <td class="num">${fmtNum(it.faltaEntregar)}</td>
        <td class="num">${it.nivelMedioCategoria !== null ? fmtPct(it.nivelMedioCategoria) : '—'}</td>
        <td class="num">${fmtPct(it.fatorAtenuacao)}</td>
        <td>${prioTag(it.prioridade)}</td>
        <td class="num">${fmtNum(it.qtdReforcoSugerida)}</td>
        <td class="num"><input type="number" min="0" step="${it.conversaoCaixas || 1}" class="editable-reforco" data-code="${escapeHtml(it.codigo)}" value="${it.qtdReforco}" style="width:90px;text-align:right;padding:4px 6px;"></td>
      </tr>
    `).join('') || `<tr><td colspan="11" style="text-align:center;color:#8a8374;">Sem resultados.</td></tr>`;

    tbody.querySelectorAll('.editable-reforco').forEach(inp => {
      inp.addEventListener('change', () => {
        const it = items.find(i => i.codigo === inp.dataset.code);
        it.qtdReforco = Math.max(0, Number(inp.value) || 0);
        inp.value = it.qtdReforco;
        scheduleCloudSave();
      });
    });
  }
  root.querySelector('#rfSearch').addEventListener('input', draw);
  root.querySelector('#rfCatFilter').addEventListener('change', draw);
  draw();

  document.getElementById('btnBackServico').addEventListener('click', () => goTo(5));
  document.getElementById('btnRecalcReforco').addEventListener('click', () => {
    if (!confirm('Isto substitui as edições pela sugestão original. Continuar?')) return;
    STATE.reforco = gerarSugestaoReforco(STATE.nivelServico.items, { pesoCategoria: STATE.config.pesoCategoriaReforco });
    scheduleCloudSave();
    render();
    toast('Reforço recalculado.', 'ok');
  });

  function reforcoRows() {
    return items.filter(i => i.qtdReforco > 0).map(i => [
      i.codigo, i.descricao, i.categoria, i.conversaoCaixas,
      i.faltaEntregar, Number(i.fatorAtenuacao.toFixed(2)), i.prioridade, i.qtdReforco, Math.ceil(i.qtdReforco / (i.conversaoCaixas || 1))
    ]);
  }
  document.getElementById('btnExportReforcoXlsx').addEventListener('click', () => {
    downloadXLSX('pedido_reforco.xlsx',
      ['Código', 'Descrição', 'Categoria', 'Unid/Caixa', 'Falta entregar', 'Fator atenuação', 'Prioridade', 'Qtd reforço', 'Caixas reforço'],
      reforcoRows());
    toast('Exportado pedido_reforco.xlsx', 'ok');
  });
  document.getElementById('btnExportReforcoCsv').addEventListener('click', () => {
    downloadCSV('pedido_reforco.csv',
      ['Código', 'Descrição', 'Categoria', 'Unid/Caixa', 'Falta entregar', 'Fator atenuação', 'Prioridade', 'Qtd reforço', 'Caixas reforço'],
      reforcoRows());
    toast('Exportado pedido_reforco.csv', 'ok');
  });

  document.getElementById('btnNovoCiclo').addEventListener('click', () => {
    if (!confirm('Isto arquiva o ciclo atual e limpa Stock, Vendas, Pedido, Nível de Serviço e Reforço para começar um novo ciclo (o Cardex mantém-se). Continuar?')) return;
    STATE.history.push({ tipo: 'reforco', data: new Date().toISOString(), itens: JSON.parse(JSON.stringify(STATE.reforco)) });
    STATE.stock = { raw: null, fileName: '', mapping: {}, items: [] };
    STATE.vendas = { raw: null, fileName: '', mapping: {}, items: [], periodoDias: 10 };
    STATE.pedidoSugerido = [];
    STATE.pedidoFinal = [];
    STATE.nivelServico = { raw: null, fileName: '', mapping: {}, items: [] };
    STATE.reforco = [];
    scheduleCloudSave();
    toast('Novo ciclo iniciado. Carregue o stock atualizado.', 'ok');
    goTo(2);
  });
}
/* ============================================================
   Bootstrap
   ============================================================ */

(function init() {
  loadLocal();
  setStoreTag(STATE.storeName || 'a ligar à nuvem…', 'busy');
  render();
  connectCloud();
})();
