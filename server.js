require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const db = require("./database");

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

// ─── AUTENTICAÇÃO SIMPLES ────────────────────────────────────────────────────

const CRM_USER = process.env.CRM_USER || "r2x";
const CRM_PASS = process.env.CRM_PASS || "r2x2026";

const APIs_PUBLICAS = ["/api/corretores/publico", "/api/leads/whatsapp"];

function autenticar(req, res, next) {
  // Páginas HTML e assets são servidos livremente — o frontend gerencia o redirecionamento
  if (!req.path.startsWith("/api/")) return next();
  // APIs públicas não precisam de token
  if (APIs_PUBLICAS.some(p => req.path.startsWith(p))) return next();
  // Demais APIs exigem token
  const token = req.headers["x-crm-token"] || req.query.token;
  const esperado = Buffer.from(`${CRM_USER}:${CRM_PASS}`).toString("base64");
  if (token === esperado) return next();
  return res.status(401).json({ ok: false, error: "Não autorizado" });
}

app.use(autenticar);
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4000;

// ─── UTILS ───────────────────────────────────────────────────────────────────

function ok(res, data) { res.json({ ok: true, data }); }
function err(res, msg, code = 400) { res.status(code).json({ ok: false, error: msg }); }

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

app.get("/api/dashboard", (req, res) => {
  const leads_total = db.prepare("SELECT COUNT(*) as n FROM leads").get().n;
  const leads_novos = db.prepare("SELECT COUNT(*) as n FROM leads WHERE status='novo'").get().n;
  const vendas_mes = db.prepare(`SELECT COALESCE(SUM(valor),0) as total FROM vendas WHERE strftime('%Y-%m', data_venda) = strftime('%Y-%m','now')`).get().total;
  const vendas_total = db.prepare("SELECT COUNT(*) as n FROM vendas WHERE status='ativo'").get().n;
  const entradas_pendentes = db.prepare("SELECT COALESCE(SUM(valor),0) as total FROM financeiro_entradas WHERE status='pendente'").get().total;
  const clientes_total = db.prepare("SELECT COUNT(*) as n FROM clientes").get().n;
  const corretores_ativos = db.prepare("SELECT COUNT(*) as n FROM corretores WHERE ativo=1").get().n;
  const corretores_total = db.prepare("SELECT COUNT(*) as n FROM corretores").get().n;
  const corretores_com_vendas = db.prepare("SELECT COUNT(DISTINCT corretor_id) as n FROM vendas WHERE status='ativo' AND corretor_id IS NOT NULL").get().n;
  const empreendimentos = db.prepare("SELECT COUNT(*) as n FROM empreendimentos").get().n;

  const ranking_vgv = db.prepare(`
    SELECT c.nome, COALESCE(SUM(v.valor),0) as vgv, COUNT(v.id) as qtd
    FROM corretores c
    JOIN vendas v ON v.corretor_id = c.id AND v.status = 'ativo'
    GROUP BY c.id ORDER BY vgv DESC LIMIT 5
  `).all();

  const ranking_qtd = db.prepare(`
    SELECT c.nome, COUNT(v.id) as qtd, COALESCE(SUM(v.valor),0) as vgv
    FROM corretores c
    JOIN vendas v ON v.corretor_id = c.id AND v.status = 'ativo'
    GROUP BY c.id ORDER BY qtd DESC LIMIT 5
  `).all();

  const aniversarios_mes = db.prepare(`
    SELECT * FROM (
      SELECT nome, telefone, aniversario, 'lead' as tipo FROM leads
      WHERE strftime('%m', aniversario) = strftime('%m','now') AND aniversario IS NOT NULL
      UNION ALL
      SELECT nome, telefone, aniversario, 'corretor' as tipo FROM corretores
      WHERE strftime('%m', aniversario) = strftime('%m','now') AND aniversario IS NOT NULL
      UNION ALL
      SELECT nome_contato as nome, telefone, aniversario, 'cliente' as tipo FROM clientes
      WHERE strftime('%m', aniversario) = strftime('%m','now') AND aniversario IS NOT NULL
    )
    ORDER BY strftime('%d', aniversario) ASC
  `).all();

  const proximos_lancamentos = db.prepare(`
    SELECT l.*, e.nome as empreendimento FROM lancamentos_calendario l
    LEFT JOIN empreendimentos e ON e.id = l.empreendimento_id
    WHERE l.data >= date('now') ORDER BY l.data LIMIT 5
  `).all();

  const funil = db.prepare(`
    SELECT status, COUNT(*) as n FROM leads GROUP BY status
  `).all();

  ok(res, {
    kpis: { leads_total, leads_novos, vendas_mes, vendas_total, entradas_pendentes, clientes_total, corretores_ativos, corretores_total, corretores_com_vendas, empreendimentos },
    aniversarios_mes,
    proximos_lancamentos,
    funil,
    ranking_vgv,
    ranking_qtd,
  });
});

// ─── CLIENTES ────────────────────────────────────────────────────────────────

app.get("/api/clientes", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(e.id) as total_empreendimentos
    FROM clientes c LEFT JOIN empreendimentos e ON e.cliente_id = c.id
    GROUP BY c.id ORDER BY c.razao_social
  `).all();
  ok(res, rows);
});

app.get("/api/clientes/:id", (req, res) => {
  const cliente = db.prepare("SELECT * FROM clientes WHERE id=?").get(req.params.id);
  if (!cliente) return err(res, "Cliente não encontrado", 404);
  const empreendimentos = db.prepare("SELECT * FROM empreendimentos WHERE cliente_id=?").all(req.params.id);
  ok(res, { ...cliente, empreendimentos });
});

app.post("/api/clientes", (req, res) => {
  const { razao_social, cnpj, nome_contato, telefone, email, cidade, estado, aniversario, observacoes } = req.body;
  if (!razao_social) return err(res, "Razão social obrigatória");
  const r = db.prepare(`INSERT INTO clientes (razao_social,cnpj,nome_contato,telefone,email,cidade,estado,aniversario,observacoes) VALUES (?,?,?,?,?,?,?,?,?)`).run(razao_social, cnpj, nome_contato, telefone, email, cidade, estado, aniversario, observacoes);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/clientes/:id", (req, res) => {
  const { razao_social, cnpj, nome_contato, telefone, email, cidade, estado, aniversario, observacoes } = req.body;
  db.prepare(`UPDATE clientes SET razao_social=?,cnpj=?,nome_contato=?,telefone=?,email=?,cidade=?,estado=?,aniversario=?,observacoes=? WHERE id=?`).run(razao_social, cnpj, nome_contato, telefone, email, cidade, estado, aniversario, observacoes, req.params.id);
  ok(res, {});
});

app.delete("/api/clientes/:id", (req, res) => {
  db.prepare("DELETE FROM clientes WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── EMPREENDIMENTOS ──────────────────────────────────────────────────────────

app.get("/api/empreendimentos/lucratividade", (req, res) => {
  const rows = db.prepare(`
    SELECT e.id, e.nome, e.cidade, e.estado, e.status,
      (SELECT COALESCE(SUM(valor),0) FROM financeiro_entradas WHERE empreendimento_id=e.id AND status='recebido') as receita_recebida,
      (SELECT COALESCE(SUM(valor),0) FROM financeiro_entradas WHERE empreendimento_id=e.id AND status!='recebido') as receita_pendente,
      (SELECT COALESCE(SUM(valor),0) FROM financeiro_saidas WHERE empreendimento_id=e.id AND status='pago') as despesa_paga,
      (SELECT COALESCE(SUM(valor),0) FROM financeiro_saidas WHERE empreendimento_id=e.id AND status!='pago') as despesa_pendente
    FROM empreendimentos e
    ORDER BY e.nome
  `).all();
  const result = rows.map(r => ({
    ...r,
    receita_total: r.receita_recebida + r.receita_pendente,
    despesa_total: r.despesa_paga + r.despesa_pendente,
    lucro_realizado: r.receita_recebida - r.despesa_paga,
    lucro_total: (r.receita_recebida + r.receita_pendente) - (r.despesa_paga + r.despesa_pendente),
  }));
  ok(res, result);
});

app.get("/api/empreendimentos", (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, c.razao_social as cliente_nome
    FROM empreendimentos e LEFT JOIN clientes c ON c.id = e.cliente_id
    ORDER BY e.nome
  `).all();
  ok(res, rows);
});

app.post("/api/empreendimentos", (req, res) => {
  const { cliente_id, nome, endereco, cidade, estado, num_unidades, vgv_estimado, status, data_lancamento, data_inicio_vendas, observacoes, percentual_r2x } = req.body;
  if (!nome) return err(res, "Nome obrigatório");
  const r = db.prepare(`INSERT INTO empreendimentos (cliente_id,nome,endereco,cidade,estado,num_unidades,vgv_estimado,status,data_lancamento,data_inicio_vendas,observacoes,percentual_r2x) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(cliente_id, nome, endereco, cidade, estado, num_unidades, vgv_estimado, status || 'prospecto', data_lancamento, data_inicio_vendas, observacoes, percentual_r2x || null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/empreendimentos/:id", (req, res) => {
  const { cliente_id, nome, endereco, cidade, estado, num_unidades, vgv_estimado, status, data_lancamento, data_inicio_vendas, observacoes, percentual_r2x } = req.body;
  db.prepare(`UPDATE empreendimentos SET cliente_id=?,nome=?,endereco=?,cidade=?,estado=?,num_unidades=?,vgv_estimado=?,status=?,data_lancamento=?,data_inicio_vendas=?,observacoes=?,percentual_r2x=? WHERE id=?`).run(cliente_id, nome, endereco, cidade, estado, num_unidades, vgv_estimado, status, data_lancamento, data_inicio_vendas, observacoes, percentual_r2x || null, req.params.id);
  ok(res, {});
});

// ─── UNIDADES ─────────────────────────────────────────────────────────────────

app.get("/api/empreendimentos/:id/unidades", (req, res) => {
  const rows = db.prepare("SELECT * FROM unidades WHERE empreendimento_id=? ORDER BY quadra, lote").all(req.params.id);
  ok(res, rows);
});

app.post("/api/empreendimentos/:id/unidades/upload", upload.single("arquivo"), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    let headerRow = -1;
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      const row = (aoa[i] || []).map(norm);
      const hasUnidade = row.some(c => c === 'lote' || c === 'lt' || c === 'apartamento' || c === 'apto' || c === 'unidade');
      const hasArea = row.some(c => c.startsWith('area') || c.startsWith('rea'));
      const hasPreco = row.some(c => c.includes('preco') || c.includes('valor'));
      if (hasUnidade && (hasArea || hasPreco)) { headerRow = i; break; }
    }
    if (headerRow === -1) return err(res, "Cabeçalho não encontrado. Use o modelo padrão (lotes: QUADRA/LOTE/AREA_M2/PRECO — prédios: ANDAR/APARTAMENTO/TIPOLOGIA/AREA_M2/PRECO).");
    const headers = aoa[headerRow].map(norm);
    const idx = (...names) => {
      for (const n of names) { const i = headers.indexOf(norm(n)); if (i !== -1) return i; }
      for (const n of names) { const i = headers.findIndex(h => h && h.includes(norm(n))); if (i !== -1) return i; }
      return -1;
    };
    const iLote = idx('LOTE', 'LT', 'APARTAMENTO', 'APTO', 'UNIDADE');
    const iQuadra = idx('QUADRA', 'QD', 'ANDAR');
    const iArea = idx('AREA_M2', 'AREA', 'ÁREA', 'AREA PRIVATIVA');
    const iPreco = idx('PRECO', 'PREÇO DO LOTE', 'PRECO DO LOTE', 'VALOR', 'PREÇO');
    const iTipologia = idx('TIPOLOGIA', 'TIPO');
    const empId = parseInt(req.params.id);
    const insert = db.prepare(`INSERT INTO unidades (empreendimento_id,quadra,lote,area_m2,preco,status) VALUES (?,?,?,?,?,?)`);
    db.prepare("DELETE FROM unidades WHERE empreendimento_id=? AND status='disponivel'").run(empId);
    let importadas = 0;
    const insertMany = db.transaction(() => {
      for (let i = headerRow + 1; i < aoa.length; i++) {
        const row = aoa[i] || [];
        let lote = iLote >= 0 ? String(row[iLote]||'').trim() : '';
        if (!lote || lote === 'null') continue;
        if (iTipologia >= 0 && row[iTipologia]) lote = `${lote} - ${String(row[iTipologia]).trim()}`;
        const quadra = iQuadra >= 0 ? String(row[iQuadra]||'').trim() : null;
        const area = iArea >= 0 ? parseFloat(row[iArea]) || null : null;
        const precoRaw = iPreco >= 0 ? row[iPreco] : null;
        const preco = precoRaw === null ? null : (typeof precoRaw === 'number' ? precoRaw : parseFloat(String(precoRaw).replace(/[R$\s]/g,'').replace(/\./g,'').replace(',','.')) || null);
        insert.run(empId, quadra || null, lote, area, preco, 'disponivel');
        importadas++;
      }
    });
    insertMany();
    const stats = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(preco),0) as vgv FROM unidades WHERE empreendimento_id=?").get(empId);
    db.prepare("UPDATE empreendimentos SET vgv_estimado=?, num_unidades=? WHERE id=?").run(stats.vgv, stats.total, empId);
    ok(res, { importadas, total: stats.total, vgv_total: stats.vgv });
  } catch (e) {
    err(res, "Erro ao processar arquivo: " + e.message);
  }
});

app.get("/api/empreendimentos/:id/contrato", (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const emp = db.prepare("SELECT * FROM empreendimentos WHERE id=?").get(empId);
    if (!emp) return err(res, "Empreendimento não encontrado");
    const cliente = emp.cliente_id ? db.prepare("SELECT * FROM clientes WHERE id=?").get(emp.cliente_id) : {};
    const extensoPct = { 1: 'um', 1.5: 'um e meio', 2: 'dois', 2.5: 'dois e meio', 3: 'três', 4: 'quatro', 5: 'cinco' };
    const pctValue = emp.percentual_r2x || 0;
    const pctExtenso = extensoPct[pctValue] || pctValue.toString().replace('.',',');
    const fmtMoney = v => v ? `${Number(v).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '';
    const dados = {
      RAZAO_SOCIAL: cliente.razao_social || '____________________',
      CNPJ: cliente.cnpj || '____________________',
      ENDERECO_CLIENTE: cliente.endereco_completo || [cliente.cidade, cliente.estado].filter(Boolean).join(' - ') || '____________________',
      EMAIL: cliente.email || '____________________',
      TELEFONE: cliente.telefone || '____________________',
      NOME_EMPREENDIMENTO: emp.nome || '____________________',
      ENDERECO_EMPREENDIMENTO: [emp.endereco, emp.cidade, emp.estado].filter(Boolean).join(' - ') || '____________________',
      NUM_UNIDADES: emp.num_unidades || '____',
      VGV_ESTIMADO: fmtMoney(emp.vgv_estimado),
      PERCENTUAL_R2X: pctValue.toString().replace('.',',') + '%',
      PERCENTUAL_EXTENSO: pctExtenso,
      NOME_REPRESENTANTE: cliente.nome_contato || '____________________',
      CIDADE_CLIENTE: cliente.cidade || '____________________',
      CIDADE_ASSINATURA: 'Braço do Norte',
    };
    const content = fs.readFileSync(path.join(__dirname, "templates", "contrato-template.docx"), "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    doc.render(dados);
    const buf = doc.getZip().generate({ type: "nodebuffer" });
    const filename = `Contrato_R2X_${(emp.nome||'empreendimento').replace(/[^a-zA-Z0-9]/g,'_')}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    console.error("[contrato]", e);
    err(res, "Erro ao gerar contrato: " + e.message);
  }
});

app.delete("/api/empreendimentos/:id/unidades", (req, res) => {
  db.prepare("DELETE FROM unidades WHERE empreendimento_id=? AND status='disponivel'").run(req.params.id);
  ok(res, {});
});

app.delete("/api/empreendimentos/:id", (req, res) => {
  db.prepare("DELETE FROM empreendimentos WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── CORRETORES ───────────────────────────────────────────────────────────────

app.get("/api/corretores", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(v.id) as total_vendas, COALESCE(SUM(v.valor),0) as vgv_vendido
    FROM corretores c LEFT JOIN vendas v ON v.corretor_id = c.id AND v.status='ativo'
    GROUP BY c.id ORDER BY vgv_vendido DESC
  `).all();
  ok(res, rows);
});

app.post("/api/corretores", (req, res) => {
  const { nome, cpf, creci, telefone, email, imobiliaria, cidade, estado, aniversario } = req.body;
  if (!nome) return err(res, "Nome obrigatório");
  const r = db.prepare(`INSERT INTO corretores (nome,cpf,creci,telefone,email,imobiliaria,cidade,estado,aniversario) VALUES (?,?,?,?,?,?,?,?,?)`).run(nome, cpf, creci, telefone, email, imobiliaria, cidade, estado, aniversario);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/corretores/:id", (req, res) => {
  const { nome, cpf, creci, telefone, email, imobiliaria, cidade, estado, aniversario, ativo } = req.body;
  db.prepare(`UPDATE corretores SET nome=?,cpf=?,creci=?,telefone=?,email=?,imobiliaria=?,cidade=?,estado=?,aniversario=?,ativo=? WHERE id=?`).run(nome, cpf, creci, telefone, email, imobiliaria, cidade, estado, aniversario, ativo !== undefined ? ativo : 1, req.params.id);
  ok(res, {});
});

app.delete("/api/corretores/:id", (req, res) => {
  db.prepare("DELETE FROM corretores WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.get("/cadastro-corretor", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cadastro-corretor.html"));
});

app.post("/api/corretores/publico", (req, res) => {
  const { nome, cpf, creci, telefone, email, imobiliaria, cidade, estado, aniversario } = req.body;
  if (!nome || !telefone) return err(res, "Nome e telefone obrigatórios");
  const existente = db.prepare("SELECT id FROM corretores WHERE telefone=?").get(telefone);
  if (existente) return err(res, "Corretor já cadastrado com este telefone");
  const r = db.prepare(`INSERT INTO corretores (nome,cpf,creci,telefone,email,imobiliaria,cidade,estado,aniversario) VALUES (?,?,?,?,?,?,?,?,?)`).run(nome, cpf, creci, telefone, email, imobiliaria, cidade, estado, aniversario);
  ok(res, { id: r.lastInsertRowid, mensagem: "Cadastro realizado com sucesso!" });
});

// ─── LEADS ───────────────────────────────────────────────────────────────────

app.get("/api/leads", (req, res) => {
  const { status, empreendimento_id } = req.query;
  let sql = `
    SELECT l.*, c.nome as corretor_nome, e.nome as empreendimento_nome
    FROM leads l
    LEFT JOIN corretores c ON c.id = l.corretor_id
    LEFT JOIN empreendimentos e ON e.id = l.empreendimento_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += " AND l.status=?"; params.push(status); }
  if (empreendimento_id) { sql += " AND l.empreendimento_id=?"; params.push(empreendimento_id); }
  sql += " ORDER BY l.criado_em DESC";
  ok(res, db.prepare(sql).all(...params));
});

app.post("/api/leads", (req, res) => {
  const { nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, origem, observacoes } = req.body;
  const r = db.prepare(`INSERT INTO leads (nome,telefone,email,cidade,objetivo,faixa_investimento,prazo,empreendimento_interesse,empreendimento_id,corretor_id,status,origem,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status || 'novo', origem || 'manual', observacoes);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/leads/:id", (req, res) => {
  const { nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, observacoes } = req.body;
  db.prepare(`UPDATE leads SET nome=?,telefone=?,email=?,cidade=?,objetivo=?,faixa_investimento=?,prazo=?,empreendimento_interesse=?,empreendimento_id=?,corretor_id=?,status=?,observacoes=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).run(nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, observacoes, req.params.id);
  ok(res, {});
});

app.delete("/api/leads/:id", (req, res) => {
  db.prepare("DELETE FROM leads WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.post("/api/leads/whatsapp", (req, res) => {
  const { telefone, nome, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse } = req.body;
  if (!telefone) return err(res, "Telefone obrigatório");
  const existente = db.prepare("SELECT id FROM leads WHERE telefone=?").get(telefone);
  if (existente) {
    db.prepare(`UPDATE leads SET nome=COALESCE(?,nome), cidade=COALESCE(?,cidade), objetivo=COALESCE(?,objetivo), faixa_investimento=COALESCE(?,faixa_investimento), prazo=COALESCE(?,prazo), empreendimento_interesse=COALESCE(?,empreendimento_interesse), atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
      .run(nome||null, cidade||null, objetivo||null, faixa_investimento||null, prazo||null, empreendimento_interesse||null, existente.id);
    return ok(res, { id: existente.id, atualizado: true });
  }
  const r = db.prepare(`INSERT INTO leads (nome,telefone,cidade,objetivo,faixa_investimento,prazo,empreendimento_interesse,status,origem) VALUES (?,?,?,?,?,?,?,'novo','whatsapp')`).run(nome, telefone, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse);
  ok(res, { id: r.lastInsertRowid, atualizado: false });
});

// ─── VENDAS ───────────────────────────────────────────────────────────────────

app.get("/api/vendas", (req, res) => {
  const rows = db.prepare(`
    SELECT v.*, l.nome as lead_nome, l.telefone as lead_telefone,
           c.nome as corretor_nome, e.nome as empreendimento_nome,
           cl.razao_social as cliente_nome
    FROM vendas v
    LEFT JOIN leads l ON l.id = v.lead_id
    LEFT JOIN corretores c ON c.id = v.corretor_id
    LEFT JOIN empreendimentos e ON e.id = v.empreendimento_id
    LEFT JOIN clientes cl ON cl.id = v.cliente_id
    ORDER BY v.data_venda DESC
  `).all();
  ok(res, rows);
});

function sincronizarComissaoVenda(vendaId) {
  const v = db.prepare("SELECT * FROM vendas WHERE id=?").get(vendaId);
  if (!v) return null;
  db.prepare("DELETE FROM financeiro_entradas WHERE venda_id=? AND tipo='comissao_venda'").run(vendaId);
  if (v.status === 'distrato' || !v.empreendimento_id) return null;
  const emp = db.prepare("SELECT percentual_r2x, nome FROM empreendimentos WHERE id=?").get(v.empreendimento_id);
  if (!emp?.percentual_r2x) return null;
  const comissao = parseFloat(((v.valor * emp.percentual_r2x) / 100).toFixed(2));
  const imovelDesc = v.imovel ? ` — ${v.imovel}` : '';
  db.prepare(`INSERT INTO financeiro_entradas (empreendimento_id,venda_id,descricao,tipo,valor,data_prevista,status) VALUES (?,?,?,?,?,?,?)`).run(
    v.empreendimento_id, vendaId,
    `Comissão R2X ${emp.percentual_r2x}% — ${emp.nome}${imovelDesc}`,
    'comissao_venda', comissao, v.data_venda, 'pendente'
  );
  db.prepare("UPDATE vendas SET percentual_r2x=?, comissao_r2x=? WHERE id=?").run(emp.percentual_r2x, comissao, vendaId);
  return comissao;
}

app.post("/api/vendas", (req, res) => {
  const { lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id, valor, data_venda, observacoes } = req.body;
  if (!valor || !data_venda) return err(res, "Valor e data obrigatórios");
  const r = db.prepare(`INSERT INTO vendas (lead_id,empreendimento_id,corretor_id,cliente_id,imovel,unidade_id,valor,data_venda,observacoes,status) VALUES (?,?,?,?,?,?,?,?,?,'ativo')`).run(lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id || null, valor, data_venda, observacoes);
  if (lead_id) db.prepare("UPDATE leads SET status='vendido' WHERE id=?").run(lead_id);
  if (unidade_id) db.prepare("UPDATE unidades SET status='vendido' WHERE id=?").run(unidade_id);
  const comissao = sincronizarComissaoVenda(r.lastInsertRowid);
  const aviso = (empreendimento_id && !comissao) ? 'Atenção: empreendimento sem % R2X cadastrado. Comissão não foi gerada.' : null;
  ok(res, { id: r.lastInsertRowid, comissao_r2x: comissao, aviso });
});

app.put("/api/vendas/:id", (req, res) => {
  const { lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id, valor, data_venda, status, observacoes } = req.body;
  const vendaAntiga = db.prepare("SELECT unidade_id, status FROM vendas WHERE id=?").get(req.params.id);
  db.prepare(`UPDATE vendas SET lead_id=?,empreendimento_id=?,corretor_id=?,cliente_id=?,imovel=?,unidade_id=?,valor=?,data_venda=?,status=?,observacoes=? WHERE id=?`).run(lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id || null, valor, data_venda, status, observacoes, req.params.id);
  if (vendaAntiga?.unidade_id && vendaAntiga.unidade_id != unidade_id) {
    db.prepare("UPDATE unidades SET status='disponivel' WHERE id=?").run(vendaAntiga.unidade_id);
  }
  if (unidade_id) db.prepare("UPDATE unidades SET status=? WHERE id=?").run(status === 'distrato' ? 'disponivel' : 'vendido', unidade_id);
  const comissao = sincronizarComissaoVenda(req.params.id);
  ok(res, { comissao_r2x: comissao });
});

app.delete("/api/vendas/:id", (req, res) => {
  const v = db.prepare("SELECT unidade_id FROM vendas WHERE id=?").get(req.params.id);
  db.prepare("DELETE FROM financeiro_entradas WHERE venda_id=?").run(req.params.id);
  if (v?.unidade_id) db.prepare("UPDATE unidades SET status='disponivel' WHERE id=?").run(v.unidade_id);
  db.prepare("DELETE FROM vendas WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.get("/api/vendas/ranking", (req, res) => {
  const { empreendimento_id, periodo } = req.query;
  let sql = `SELECT c.nome, c.imobiliaria, COUNT(v.id) as vendas, COALESCE(SUM(v.valor),0) as vgv FROM vendas v JOIN corretores c ON c.id=v.corretor_id WHERE v.status='ativo'`;
  const params = [];
  if (empreendimento_id) { sql += " AND v.empreendimento_id=?"; params.push(empreendimento_id); }
  if (periodo === 'mes') { sql += " AND strftime('%Y-%m',v.data_venda)=strftime('%Y-%m','now')"; }
  sql += " GROUP BY c.id ORDER BY vgv DESC LIMIT 20";
  ok(res, db.prepare(sql).all(...params));
});

// ─── FINANCEIRO ENTRADAS ──────────────────────────────────────────────────────

app.get("/api/financeiro/entradas", (req, res) => {
  const rows = db.prepare(`SELECT f.*, e.nome as empreendimento_nome, n.numero as nota_fiscal_numero FROM financeiro_entradas f LEFT JOIN empreendimentos e ON e.id = f.empreendimento_id LEFT JOIN notas_fiscais n ON n.id = f.nota_fiscal_id ORDER BY f.data_prevista DESC`).all();
  ok(res, rows);
});

app.post("/api/financeiro/entradas", (req, res) => {
  const { empreendimento_id, venda_id, descricao, tipo, valor, data_prevista, data_recebimento, status, observacoes, parcela_num, parcela_total } = req.body;
  if (!descricao || !valor) return err(res, "Descrição e valor obrigatórios");
  const r = db.prepare(`INSERT INTO financeiro_entradas (empreendimento_id,venda_id,descricao,tipo,valor,data_prevista,data_recebimento,status,observacoes,parcela_num,parcela_total) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(empreendimento_id, venda_id, descricao, tipo, valor, data_prevista, data_recebimento, status || 'pendente', observacoes, parcela_num||null, parcela_total||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/financeiro/entradas/:id", (req, res) => {
  const { empreendimento_id, descricao, tipo, valor, data_prevista, data_recebimento, status, observacoes, parcela_num, parcela_total } = req.body;
  db.prepare(`UPDATE financeiro_entradas SET empreendimento_id=?,descricao=?,tipo=?,valor=?,data_prevista=?,data_recebimento=?,status=?,observacoes=?,parcela_num=?,parcela_total=? WHERE id=?`).run(empreendimento_id, descricao, tipo, valor, data_prevista, data_recebimento, status, observacoes, parcela_num||null, parcela_total||null, req.params.id);
  ok(res, {});
});

app.delete("/api/financeiro/entradas/:id", (req, res) => {
  db.prepare("DELETE FROM financeiro_entradas WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── FINANCEIRO SAÍDAS ────────────────────────────────────────────────────────

app.get("/api/financeiro/saidas", (req, res) => {
  const rows = db.prepare(`SELECT f.*, e.nome as empreendimento_nome FROM financeiro_saidas f LEFT JOIN empreendimentos e ON e.id = f.empreendimento_id ORDER BY f.data_pagamento DESC`).all();
  ok(res, rows);
});

app.post("/api/financeiro/saidas", (req, res) => {
  const { empreendimento_id, descricao, categoria, valor, data_pagamento, status, recorrente, observacoes } = req.body;
  if (!descricao || !valor) return err(res, "Descrição e valor obrigatórios");
  const r = db.prepare(`INSERT INTO financeiro_saidas (empreendimento_id,descricao,categoria,valor,data_pagamento,status,recorrente,observacoes) VALUES (?,?,?,?,?,?,?,?)`).run(empreendimento_id, descricao, categoria, valor, data_pagamento, status || 'pendente', recorrente ? 1 : 0, observacoes);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/financeiro/saidas/:id", (req, res) => {
  const { empreendimento_id, descricao, categoria, valor, data_pagamento, status, recorrente, observacoes } = req.body;
  db.prepare(`UPDATE financeiro_saidas SET empreendimento_id=?,descricao=?,categoria=?,valor=?,data_pagamento=?,status=?,recorrente=?,observacoes=? WHERE id=?`).run(empreendimento_id, descricao, categoria, valor, data_pagamento, status, recorrente ? 1 : 0, observacoes, req.params.id);
  ok(res, {});
});

app.delete("/api/financeiro/saidas/:id", (req, res) => {
  db.prepare("DELETE FROM financeiro_saidas WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── NOTAS FISCAIS ────────────────────────────────────────────────────────────
// Vincula o recebimento de uma NF emitida pelo contador aos lançamentos de
// contas a receber (financeiro_entradas) já criados quando as vendas foram lançadas.

function listarEntradasVinculadas(notaId) {
  return db.prepare(`SELECT id, descricao, valor, data_prevista, status, empreendimento_id FROM financeiro_entradas WHERE nota_fiscal_id=? ORDER BY data_prevista`).all(notaId);
}

function parseEntradaIds(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  } catch (_) { return []; }
}

app.get("/api/financeiro/notas-fiscais", (req, res) => {
  const rows = db.prepare(`
    SELECT n.id, n.numero, n.serie, n.empreendimento_id, n.cliente_id, n.valor, n.data_emissao, n.data_recebimento, n.status, n.observacoes, n.criado_em,
           n.arquivo_nome, (n.arquivo_dados IS NOT NULL) as tem_arquivo,
           e.nome as empreendimento_nome, c.razao_social as cliente_nome,
           COALESCE((SELECT SUM(valor) FROM financeiro_entradas WHERE nota_fiscal_id=n.id),0) as valor_vinculado,
           (SELECT COUNT(*) FROM financeiro_entradas WHERE nota_fiscal_id=n.id) as qtd_entradas
    FROM notas_fiscais n
    LEFT JOIN empreendimentos e ON e.id = n.empreendimento_id
    LEFT JOIN clientes c ON c.id = n.cliente_id
    ORDER BY n.data_emissao DESC, n.id DESC
  `).all();
  ok(res, rows);
});

app.get("/api/financeiro/notas-fiscais/:id", (req, res) => {
  const nf = db.prepare(`
    SELECT n.id, n.numero, n.serie, n.empreendimento_id, n.cliente_id, n.valor, n.data_emissao, n.data_recebimento, n.status, n.observacoes, n.criado_em,
           n.arquivo_nome, (n.arquivo_dados IS NOT NULL) as tem_arquivo,
           e.nome as empreendimento_nome, c.razao_social as cliente_nome
    FROM notas_fiscais n
    LEFT JOIN empreendimentos e ON e.id = n.empreendimento_id
    LEFT JOIN clientes c ON c.id = n.cliente_id
    WHERE n.id = ?
  `).get(req.params.id);
  if (!nf) return err(res, "Nota fiscal não encontrada", 404);
  nf.entradas = listarEntradasVinculadas(nf.id);
  ok(res, nf);
});

app.post("/api/financeiro/notas-fiscais", upload.single("arquivo"), (req, res) => {
  const { numero, serie, empreendimento_id, cliente_id, valor, data_emissao, observacoes } = req.body;
  if (!numero || !valor || !data_emissao) return err(res, "Número, valor e data de emissão são obrigatórios");
  const entradaIds = parseEntradaIds(req.body.entrada_ids);
  if (entradaIds.length) {
    const jaVinculadas = db.prepare(`SELECT id FROM financeiro_entradas WHERE id IN (${entradaIds.map(() => '?').join(',')}) AND nota_fiscal_id IS NOT NULL`).all(...entradaIds);
    if (jaVinculadas.length) return err(res, "Uma ou mais contas a receber selecionadas já estão vinculadas a outra nota fiscal");
  }
  const r = db.prepare(`INSERT INTO notas_fiscais (numero,serie,empreendimento_id,cliente_id,valor,data_emissao,observacoes,arquivo_nome,arquivo_mime,arquivo_dados) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    numero, serie || null, empreendimento_id || null, cliente_id || null, parseFloat(valor), data_emissao, observacoes || null,
    req.file?.originalname || null, req.file?.mimetype || null, req.file?.buffer || null
  );
  const notaId = r.lastInsertRowid;
  if (entradaIds.length) {
    const upd = db.prepare("UPDATE financeiro_entradas SET nota_fiscal_id=? WHERE id=?");
    db.transaction(() => entradaIds.forEach(id => upd.run(notaId, id)))();
  }
  ok(res, { id: notaId });
});

app.put("/api/financeiro/notas-fiscais/:id", upload.single("arquivo"), (req, res) => {
  const notaId = req.params.id;
  const nfExiste = db.prepare("SELECT id FROM notas_fiscais WHERE id=?").get(notaId);
  if (!nfExiste) return err(res, "Nota fiscal não encontrada", 404);
  const { numero, serie, empreendimento_id, cliente_id, valor, data_emissao, observacoes } = req.body;
  if (!numero || !valor || !data_emissao) return err(res, "Número, valor e data de emissão são obrigatórios");
  const entradaIds = parseEntradaIds(req.body.entrada_ids);
  if (entradaIds.length) {
    const jaVinculadas = db.prepare(`SELECT id FROM financeiro_entradas WHERE id IN (${entradaIds.map(() => '?').join(',')}) AND nota_fiscal_id IS NOT NULL AND nota_fiscal_id != ?`).all(...entradaIds, notaId);
    if (jaVinculadas.length) return err(res, "Uma ou mais contas a receber selecionadas já estão vinculadas a outra nota fiscal");
  }
  if (req.file) {
    db.prepare(`UPDATE notas_fiscais SET numero=?,serie=?,empreendimento_id=?,cliente_id=?,valor=?,data_emissao=?,observacoes=?,arquivo_nome=?,arquivo_mime=?,arquivo_dados=? WHERE id=?`)
      .run(numero, serie || null, empreendimento_id || null, cliente_id || null, parseFloat(valor), data_emissao, observacoes || null, req.file.originalname, req.file.mimetype, req.file.buffer, notaId);
  } else {
    db.prepare(`UPDATE notas_fiscais SET numero=?,serie=?,empreendimento_id=?,cliente_id=?,valor=?,data_emissao=?,observacoes=? WHERE id=?`)
      .run(numero, serie || null, empreendimento_id || null, cliente_id || null, parseFloat(valor), data_emissao, observacoes || null, notaId);
  }
  db.transaction(() => {
    const nfAtual = db.prepare("SELECT status, data_recebimento FROM notas_fiscais WHERE id=?").get(notaId);
    // desvincula e reverte para pendente as contas que saíram da seleção (evita deixar "recebido" órfão sem NF)
    const antigos = db.prepare("SELECT id FROM financeiro_entradas WHERE nota_fiscal_id=?").all(notaId).map(r => r.id);
    const removidos = antigos.filter(id => !entradaIds.includes(id));
    if (removidos.length) {
      db.prepare(`UPDATE financeiro_entradas SET nota_fiscal_id=NULL, status='pendente', data_recebimento=NULL WHERE id IN (${removidos.map(() => '?').join(',')})`).run(...removidos);
    }
    const upd = db.prepare("UPDATE financeiro_entradas SET nota_fiscal_id=? WHERE id=?");
    entradaIds.forEach(id => upd.run(notaId, id));
    // se a NF já estava recebida, propaga o status para as contas que permanecem/entraram vinculadas
    if (nfAtual?.status === 'recebida' && entradaIds.length) {
      db.prepare("UPDATE financeiro_entradas SET status='recebido', data_recebimento=? WHERE nota_fiscal_id=?").run(nfAtual.data_recebimento, notaId);
    }
  })();
  ok(res, {});
});

app.post("/api/financeiro/notas-fiscais/:id/receber", (req, res) => {
  const notaId = req.params.id;
  const nf = db.prepare("SELECT id FROM notas_fiscais WHERE id=?").get(notaId);
  if (!nf) return err(res, "Nota fiscal não encontrada", 404);
  const data = req.body.data_recebimento || new Date().toISOString().slice(0, 10);
  db.transaction(() => {
    db.prepare("UPDATE notas_fiscais SET status='recebida', data_recebimento=? WHERE id=?").run(data, notaId);
    db.prepare("UPDATE financeiro_entradas SET status='recebido', data_recebimento=? WHERE nota_fiscal_id=?").run(data, notaId);
  })();
  ok(res, {});
});

app.post("/api/financeiro/notas-fiscais/:id/estornar", (req, res) => {
  const notaId = req.params.id;
  const nf = db.prepare("SELECT id FROM notas_fiscais WHERE id=?").get(notaId);
  if (!nf) return err(res, "Nota fiscal não encontrada", 404);
  db.transaction(() => {
    db.prepare("UPDATE notas_fiscais SET status='pendente', data_recebimento=NULL WHERE id=?").run(notaId);
    db.prepare("UPDATE financeiro_entradas SET status='pendente', data_recebimento=NULL WHERE nota_fiscal_id=?").run(notaId);
  })();
  ok(res, {});
});

app.delete("/api/financeiro/notas-fiscais/:id", (req, res) => {
  db.transaction(() => {
    db.prepare("UPDATE financeiro_entradas SET nota_fiscal_id=NULL WHERE nota_fiscal_id=?").run(req.params.id);
    db.prepare("DELETE FROM notas_fiscais WHERE id=?").run(req.params.id);
  })();
  ok(res, {});
});

app.get("/api/financeiro/notas-fiscais/:id/arquivo", (req, res) => {
  const nf = db.prepare("SELECT arquivo_nome, arquivo_mime, arquivo_dados FROM notas_fiscais WHERE id=?").get(req.params.id);
  if (!nf || !nf.arquivo_dados) return err(res, "Arquivo não encontrado", 404);
  res.setHeader("Content-Type", nf.arquivo_mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${(nf.arquivo_nome || "nota-fiscal").replace(/"/g, "")}"`);
  res.send(nf.arquivo_dados);
});

// ─── DISTRIBUIÇÕES ────────────────────────────────────────────────────────────

app.get("/api/financeiro/distribuicoes", (req, res) => {
  ok(res, db.prepare("SELECT * FROM distribuicoes ORDER BY data DESC").all());
});

app.post("/api/financeiro/distribuicoes", (req, res) => {
  const { descricao, valor, data, observacoes } = req.body;
  if (!valor || !data) return err(res, "Valor e data obrigatórios");
  const r = db.prepare("INSERT INTO distribuicoes (descricao,valor,data,observacoes) VALUES (?,?,?,?)").run(descricao, valor, data, observacoes);
  ok(res, { id: r.lastInsertRowid });
});

app.delete("/api/financeiro/distribuicoes/:id", (req, res) => {
  db.prepare("DELETE FROM distribuicoes WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── CALENDÁRIO ───────────────────────────────────────────────────────────────

app.get("/api/calendario", (req, res) => {
  const rows = db.prepare(`SELECT l.*, e.nome as empreendimento_nome FROM lancamentos_calendario l LEFT JOIN empreendimentos e ON e.id = l.empreendimento_id ORDER BY l.data`).all();
  ok(res, rows);
});

app.post("/api/calendario", (req, res) => {
  const { empreendimento_id, titulo, data, tipo, descricao } = req.body;
  if (!titulo || !data) return err(res, "Título e data obrigatórios");
  const r = db.prepare("INSERT INTO lancamentos_calendario (empreendimento_id,titulo,data,tipo,descricao) VALUES (?,?,?,?,?)").run(empreendimento_id, titulo, data, tipo || 'lancamento', descricao);
  ok(res, { id: r.lastInsertRowid });
});

app.delete("/api/calendario/:id", (req, res) => {
  db.prepare("DELETE FROM lancamentos_calendario WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── RESUMO FINANCEIRO POR EMPREENDIMENTO ─────────────────────────────────────

app.get("/api/financeiro/resumo", (req, res) => {
  const resumo = db.prepare(`
    SELECT e.id, e.nome,
      COALESCE((SELECT SUM(valor) FROM financeiro_entradas WHERE empreendimento_id=e.id AND status='recebido'),0) as entradas_recebidas,
      COALESCE((SELECT SUM(valor) FROM financeiro_entradas WHERE empreendimento_id=e.id AND status='pendente'),0) as entradas_pendentes,
      COALESCE((SELECT SUM(valor) FROM financeiro_saidas WHERE empreendimento_id=e.id AND status='pago'),0) as saidas_pagas,
      COALESCE((SELECT SUM(valor) FROM financeiro_saidas WHERE empreendimento_id=e.id AND status='pendente'),0) as saidas_pendentes,
      COALESCE((SELECT SUM(valor) FROM vendas WHERE empreendimento_id=e.id AND status='ativo'),0) as vgv_vendido
    FROM empreendimentos e ORDER BY e.nome
  `).all();
  const total_distribuicoes = db.prepare("SELECT COALESCE(SUM(valor),0) as total FROM distribuicoes").get().total;
  ok(res, { empreendimentos: resumo, total_distribuicoes });
});


// ─── GESTÃO PESSOAL ──────────────────────────────────────────────────────────

// Dashboard PF
app.get("/api/pf/dashboard", (req, res) => {
  const mes = new Date().toISOString().slice(0, 7);
  const entradas_mes = db.prepare(`SELECT COALESCE(SUM(valor),0) as total FROM pf_entradas WHERE strftime('%Y-%m', data)=? AND recebido=1`).get(mes).total;
  const entradas_pendentes = db.prepare(`SELECT COALESCE(SUM(valor),0) as total FROM pf_entradas WHERE strftime('%Y-%m', data)=? AND recebido=0`).get(mes).total;
  const cartoes_mes = db.prepare(`SELECT COALESCE(SUM(valor),0) as total FROM pf_lancamentos_cartao WHERE mes_fatura=?`).get(mes).total;
  const fixas_pagas = db.prepare(`SELECT COALESCE(SUM(cf.valor),0) as total FROM pf_contas_fixas cf LEFT JOIN pf_pagamentos_fixos pf ON pf.conta_fixa_id=cf.id AND pf.mes_ano=? WHERE cf.ativa=1 AND pf.pago=1`).get(mes).total;
  const fixas_pendentes = db.prepare(`SELECT COALESCE(SUM(cf.valor),0) as total FROM pf_contas_fixas cf LEFT JOIN pf_pagamentos_fixos pf ON pf.conta_fixa_id=cf.id AND pf.mes_ano=? WHERE cf.ativa=1 AND (pf.pago IS NULL OR pf.pago=0)`).get(mes).total;
  const contas = db.prepare(`SELECT c.*, COALESCE((SELECT SUM(valor) FROM pf_transacoes WHERE conta_id=c.id AND tipo='entrada'),0) as total_entradas, COALESCE((SELECT SUM(valor) FROM pf_transacoes WHERE conta_id=c.id AND tipo='saida'),0) as total_saidas FROM pf_contas c`).all();
  const saldo_total = contas.reduce((s,c) => s + c.saldo_inicial + c.total_entradas - c.total_saidas, 0);
  const ultimas_entradas = db.prepare(`SELECT e.*, f.nome as fonte_nome FROM pf_entradas e LEFT JOIN pf_fontes_renda f ON f.id=e.fonte_id ORDER BY e.data DESC LIMIT 5`).all();
  const ultimos_cartao = db.prepare(`SELECT l.*, c.nome as cartao_nome FROM pf_lancamentos_cartao l LEFT JOIN pf_cartoes c ON c.id=l.cartao_id ORDER BY l.data DESC LIMIT 5`).all();
  ok(res, { kpis: { entradas_mes, entradas_pendentes, cartoes_mes, fixas_pagas, fixas_pendentes, saldo_total }, contas, ultimas_entradas, ultimos_cartao, mes });
});

// ── Contas Bancárias ─────────────────────────────────────────────────────────
app.get("/api/pf/contas", (req, res) => {
  const contas = db.prepare(`SELECT c.*, COALESCE((SELECT SUM(valor) FROM pf_transacoes WHERE conta_id=c.id AND tipo='entrada'),0) as total_entradas, COALESCE((SELECT SUM(valor) FROM pf_transacoes WHERE conta_id=c.id AND tipo='saida'),0) as total_saidas, (SELECT COUNT(*) FROM pf_transacoes WHERE conta_id=c.id) as num_transacoes FROM pf_contas c GROUP BY c.id ORDER BY c.titular, c.nome`).all();
  ok(res, contas.map(c => ({ ...c, saldo: c.saldo_inicial + c.total_entradas - c.total_saidas })));
});

app.post("/api/pf/contas", (req, res) => {
  const { nome, banco, titular, tipo, saldo_inicial } = req.body;
  if (!nome) return err(res, "Nome obrigatório");
  const r = db.prepare(`INSERT INTO pf_contas (nome,banco,titular,tipo,saldo_inicial) VALUES (?,?,?,?,?)`).run(nome, banco, titular||'Ramon', tipo||'corrente', parseFloat(saldo_inicial)||0);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/pf/contas/:id", (req, res) => {
  const { nome, banco, titular, tipo, saldo_inicial } = req.body;
  db.prepare(`UPDATE pf_contas SET nome=?,banco=?,titular=?,tipo=?,saldo_inicial=? WHERE id=?`).run(nome, banco, titular, tipo, parseFloat(saldo_inicial)||0, req.params.id);
  ok(res, {});
});

app.delete("/api/pf/contas/:id", (req, res) => {
  db.prepare("DELETE FROM pf_contas WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.get("/api/pf/contas/:id/transacoes", (req, res) => {
  const { mes } = req.query;
  let sql = "SELECT * FROM pf_transacoes WHERE conta_id=?";
  const params = [req.params.id];
  if (mes) { sql += " AND strftime('%Y-%m',data)=?"; params.push(mes); }
  sql += " ORDER BY data DESC";
  ok(res, db.prepare(sql).all(...params));
});

app.post("/api/pf/contas/:id/transacoes", (req, res) => {
  const { data, descricao, valor, tipo, categoria, observacoes } = req.body;
  if (!data || !descricao || !valor) return err(res, "Data, descrição e valor obrigatórios");
  const r = db.prepare(`INSERT INTO pf_transacoes (conta_id,data,descricao,valor,tipo,categoria,observacoes) VALUES (?,?,?,?,?,?,?)`).run(req.params.id, data, descricao, parseFloat(valor), tipo||'saida', categoria, observacoes);
  ok(res, { id: r.lastInsertRowid });
});

app.delete("/api/pf/transacoes/:id", (req, res) => {
  db.prepare("DELETE FROM pf_transacoes WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.post("/api/pf/contas/:id/upload", upload.single("arquivo"), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    let headerRow = -1;
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      const row = (aoa[i]||[]).map(norm);
      if (row.some(c=>c.includes('data')||c.includes('date')) && row.some(c=>c.includes('valor')||c.includes('value')||c.includes('quantia'))) { headerRow = i; break; }
    }
    if (headerRow === -1) return err(res, "Formato não reconhecido. Colunas esperadas: DATA, DESCRICAO, VALOR, TIPO");
    const headers = aoa[headerRow].map(norm);
    const idx = (...names) => { for (const n of names) { const i = headers.indexOf(norm(n)); if (i!==-1) return i; } for (const n of names) { const i = headers.findIndex(h=>h&&h.includes(norm(n))); if (i!==-1) return i; } return -1; };
    const iData=idx('data','date','dt'), iDesc=idx('descricao','historico','description','memo'), iValor=idx('valor','value','quantia','montante'), iTipo=idx('tipo','type','dc','debcred');
    const insert = db.prepare(`INSERT INTO pf_transacoes (conta_id,data,descricao,valor,tipo,origem) VALUES (?,?,?,?,?,?)`);
    let importadas = 0;
    db.transaction(() => {
      for (let i = headerRow+1; i < aoa.length; i++) {
        const row = aoa[i]||[];
        let dataVal = iData>=0?row[iData]:null, desc = iDesc>=0?String(row[iDesc]||'').trim():'', valorRaw = iValor>=0?row[iValor]:null;
        if (!dataVal || !desc) continue;
        let dataStr = null;
        if (typeof dataVal==='number') { const d=new Date(Math.round((dataVal-25569)*86400*1000)); dataStr=d.toISOString().split('T')[0]; }
        else { const s=String(dataVal).trim(); if (s.includes('/')) { const p=s.split('/'); dataStr=p.length===3&&p[2].length===4?`${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`:s; } else dataStr=s.split('T')[0]; }
        if (!dataStr) continue;
        let valor = typeof valorRaw==='number'?valorRaw:parseFloat(String(valorRaw||'').replace(/[R$\s]/g,'').replace(/\./g,'').replace(',','.'));
        if (isNaN(valor)) continue;
        let tipo = 'saida';
        if (iTipo>=0&&row[iTipo]) { const t=String(row[iTipo]).toLowerCase(); if (t.includes('c')||t.includes('entrada')||t.includes('cred')) tipo='entrada'; } else if (valor>0) tipo='entrada';
        insert.run(req.params.id, dataStr, desc, Math.abs(valor), tipo, 'extrato');
        importadas++;
      }
    })();
    ok(res, { importadas });
  } catch(e) { err(res, "Erro ao processar: "+e.message); }
});

// ── Cartões de Crédito ───────────────────────────────────────────────────────
app.get("/api/pf/cartoes", (req, res) => {
  const mes = new Date().toISOString().slice(0,7);
  ok(res, db.prepare(`SELECT c.*, COALESCE((SELECT SUM(valor) FROM pf_lancamentos_cartao WHERE cartao_id=c.id AND mes_fatura=?),0) as total_mes FROM pf_cartoes c ORDER BY c.titular, c.nome`).all(mes));
});

app.post("/api/pf/cartoes", (req, res) => {
  const { nome, bandeira, limite, dia_fechamento, dia_vencimento, titular } = req.body;
  if (!nome) return err(res, "Nome obrigatório");
  const r = db.prepare(`INSERT INTO pf_cartoes (nome,bandeira,limite,dia_fechamento,dia_vencimento,titular) VALUES (?,?,?,?,?,?)`).run(nome, bandeira, parseFloat(limite)||null, parseInt(dia_fechamento)||null, parseInt(dia_vencimento)||null, titular||'Ramon');
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/pf/cartoes/:id", (req, res) => {
  const { nome, bandeira, limite, dia_fechamento, dia_vencimento, titular } = req.body;
  db.prepare(`UPDATE pf_cartoes SET nome=?,bandeira=?,limite=?,dia_fechamento=?,dia_vencimento=?,titular=? WHERE id=?`).run(nome, bandeira, parseFloat(limite)||null, parseInt(dia_fechamento)||null, parseInt(dia_vencimento)||null, titular||'Ramon', req.params.id);
  ok(res, {});
});

app.delete("/api/pf/cartoes/:id", (req, res) => {
  db.prepare("DELETE FROM pf_cartoes WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.get("/api/pf/cartoes/:id/lancamentos", (req, res) => {
  const { mes } = req.query;
  let sql = "SELECT * FROM pf_lancamentos_cartao WHERE cartao_id=?";
  const params = [req.params.id];
  if (mes) { sql += " AND mes_fatura=?"; params.push(mes); }
  sql += " ORDER BY data DESC";
  ok(res, db.prepare(sql).all(...params));
});

app.post("/api/pf/cartoes/:id/lancamentos", (req, res) => {
  const { data, descricao, valor, categoria, parcela_num, parcela_total, mes_fatura } = req.body;
  if (!data||!descricao||!valor) return err(res, "Data, descrição e valor obrigatórios");
  const r = db.prepare(`INSERT INTO pf_lancamentos_cartao (cartao_id,data,descricao,valor,categoria,parcela_num,parcela_total,mes_fatura) VALUES (?,?,?,?,?,?,?,?)`).run(req.params.id, data, descricao, parseFloat(valor), categoria, parcela_num||null, parcela_total||null, mes_fatura||data.slice(0,7));
  ok(res, { id: r.lastInsertRowid });
});

app.delete("/api/pf/lancamentos-cartao/:id", (req, res) => {
  db.prepare("DELETE FROM pf_lancamentos_cartao WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.post("/api/pf/cartoes/:id/upload", upload.single("arquivo"), (req, res) => {
  try {
    const { mes_fatura } = req.body;
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    let headerRow = -1;
    for (let i = 0; i < Math.min(aoa.length,10); i++) {
      const row = (aoa[i]||[]).map(norm);
      if (row.some(c=>c.includes('data')) && row.some(c=>c.includes('valor')||c.includes('quantia'))) { headerRow=i; break; }
    }
    if (headerRow===-1) return err(res, "Formato não reconhecido");
    const headers = aoa[headerRow].map(norm);
    const idx = (...names) => { for (const n of names) { const i=headers.indexOf(norm(n)); if (i!==-1) return i; } for (const n of names) { const i=headers.findIndex(h=>h&&h.includes(norm(n))); if (i!==-1) return i; } return -1; };
    const iData=idx('data','date'), iDesc=idx('descricao','historico','estabelecimento'), iValor=idx('valor','quantia'), iCat=idx('categoria','category');
    const insert = db.prepare(`INSERT INTO pf_lancamentos_cartao (cartao_id,data,descricao,valor,categoria,mes_fatura,origem) VALUES (?,?,?,?,?,?,?)`);
    const mesFat = mes_fatura || new Date().toISOString().slice(0,7);
    let importadas = 0;
    db.transaction(() => {
      for (let i = headerRow+1; i < aoa.length; i++) {
        const row = aoa[i]||[];
        let dataVal=iData>=0?row[iData]:null, desc=iDesc>=0?String(row[iDesc]||'').trim():'', valorRaw=iValor>=0?row[iValor]:null;
        if (!dataVal||!desc) continue;
        let dataStr=null;
        if (typeof dataVal==='number') { const d=new Date(Math.round((dataVal-25569)*86400*1000)); dataStr=d.toISOString().split('T')[0]; }
        else { const s=String(dataVal).trim(); if (s.includes('/')) { const p=s.split('/'); dataStr=p.length===3&&p[2].length===4?`${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`:s; } else dataStr=s.split('T')[0]; }
        if (!dataStr) continue;
        let valor=typeof valorRaw==='number'?Math.abs(valorRaw):Math.abs(parseFloat(String(valorRaw||'').replace(/[R$\s]/g,'').replace(/\./g,'').replace(',','.')));
        if (isNaN(valor)||valor===0) continue;
        insert.run(req.params.id, dataStr, desc, valor, iCat>=0?String(row[iCat]||'').trim()||null:null, mesFat, 'extrato');
        importadas++;
      }
    })();
    ok(res, { importadas });
  } catch(e) { err(res, "Erro ao processar: "+e.message); }
});

// ── Contas Fixas ─────────────────────────────────────────────────────────────
app.get("/api/pf/contas-fixas", (req, res) => {
  const mes = req.query.mes || new Date().toISOString().slice(0,7);
  ok(res, db.prepare(`SELECT cf.*, pf.pago, pf.data_pagamento, pf.valor as valor_pago, pf.observacoes as obs_pagamento FROM pf_contas_fixas cf LEFT JOIN pf_pagamentos_fixos pf ON pf.conta_fixa_id=cf.id AND pf.mes_ano=? WHERE cf.ativa=1 ORDER BY cf.dia_vencimento, cf.nome`).all(mes));
});

app.post("/api/pf/contas-fixas", (req, res) => {
  const { nome, valor, dia_vencimento, categoria } = req.body;
  if (!nome||!valor) return err(res, "Nome e valor obrigatórios");
  const r = db.prepare(`INSERT INTO pf_contas_fixas (nome,valor,dia_vencimento,categoria) VALUES (?,?,?,?)`).run(nome, parseFloat(valor), parseInt(dia_vencimento)||null, categoria||'casa');
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/pf/contas-fixas/:id", (req, res) => {
  const { nome, valor, dia_vencimento, categoria, ativa } = req.body;
  db.prepare(`UPDATE pf_contas_fixas SET nome=?,valor=?,dia_vencimento=?,categoria=?,ativa=? WHERE id=?`).run(nome, parseFloat(valor), parseInt(dia_vencimento)||null, categoria||'casa', ativa!==undefined?ativa:1, req.params.id);
  ok(res, {});
});

app.delete("/api/pf/contas-fixas/:id", (req, res) => {
  db.prepare("DELETE FROM pf_contas_fixas WHERE id=?").run(req.params.id);
  ok(res, {});
});

app.post("/api/pf/contas-fixas/:id/pagar", (req, res) => {
  const { mes_ano, data_pagamento, valor, observacoes } = req.body;
  const mes = mes_ano || new Date().toISOString().slice(0,7);
  const conta = db.prepare("SELECT * FROM pf_contas_fixas WHERE id=?").get(req.params.id);
  if (!conta) return err(res, "Conta não encontrada");
  const dataPag = data_pagamento || new Date().toISOString().split('T')[0];
  const valorPag = parseFloat(valor)||conta.valor;
  db.prepare(`INSERT INTO pf_pagamentos_fixos (conta_fixa_id,mes_ano,pago,data_pagamento,valor,observacoes) VALUES (?,?,1,?,?,?) ON CONFLICT(conta_fixa_id,mes_ano) DO UPDATE SET pago=1,data_pagamento=?,valor=?,observacoes=?`).run(req.params.id, mes, dataPag, valorPag, observacoes, dataPag, valorPag, observacoes);
  ok(res, {});
});

app.post("/api/pf/contas-fixas/:id/despagar", (req, res) => {
  const mes = req.body.mes_ano || new Date().toISOString().slice(0,7);
  db.prepare("UPDATE pf_pagamentos_fixos SET pago=0,data_pagamento=NULL WHERE conta_fixa_id=? AND mes_ano=?").run(req.params.id, mes);
  ok(res, {});
});

// ── Fontes de Renda ──────────────────────────────────────────────────────────
app.get("/api/pf/fontes-renda", (req, res) => {
  ok(res, db.prepare(`SELECT f.*, COALESCE((SELECT SUM(valor) FROM pf_entradas WHERE fonte_id=f.id AND recebido=1),0) as total_recebido FROM pf_fontes_renda f WHERE f.ativa=1 ORDER BY f.tipo, f.nome`).all());
});

app.post("/api/pf/fontes-renda", (req, res) => {
  const { nome, tipo, descricao, titular } = req.body;
  if (!nome) return err(res, "Nome obrigatório");
  const r = db.prepare(`INSERT INTO pf_fontes_renda (nome,tipo,descricao,titular) VALUES (?,?,?,?)`).run(nome, tipo||'empresa', descricao, titular||'Ramon');
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/pf/fontes-renda/:id", (req, res) => {
  const { nome, tipo, descricao, titular, ativa } = req.body;
  db.prepare(`UPDATE pf_fontes_renda SET nome=?,tipo=?,descricao=?,titular=?,ativa=? WHERE id=?`).run(nome, tipo, descricao, titular, ativa!==undefined?ativa:1, req.params.id);
  ok(res, {});
});

app.delete("/api/pf/fontes-renda/:id", (req, res) => {
  db.prepare("DELETE FROM pf_fontes_renda WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ── Entradas Pessoais ────────────────────────────────────────────────────────
app.get("/api/pf/entradas", (req, res) => {
  const { mes } = req.query;
  let sql = `SELECT e.*, f.nome as fonte_nome, f.tipo as fonte_tipo FROM pf_entradas e LEFT JOIN pf_fontes_renda f ON f.id=e.fonte_id WHERE 1=1`;
  const params = [];
  if (mes) { sql += " AND strftime('%Y-%m',e.data)=?"; params.push(mes); }
  sql += " ORDER BY e.data DESC";
  ok(res, db.prepare(sql).all(...params));
});

app.post("/api/pf/entradas", (req, res) => {
  const { fonte_id, data, valor, descricao, recebido, titular } = req.body;
  if (!data||!valor) return err(res, "Data e valor obrigatórios");
  const r = db.prepare(`INSERT INTO pf_entradas (fonte_id,data,valor,descricao,recebido,titular) VALUES (?,?,?,?,?,?)`).run(fonte_id||null, data, parseFloat(valor), descricao, recebido!==undefined?(recebido?1:0):1, titular||'Ramon');
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/pf/entradas/:id", (req, res) => {
  const { fonte_id, data, valor, descricao, recebido, titular } = req.body;
  db.prepare(`UPDATE pf_entradas SET fonte_id=?,data=?,valor=?,descricao=?,recebido=?,titular=? WHERE id=?`).run(fonte_id||null, data, parseFloat(valor), descricao, recebido?1:0, titular||'Ramon', req.params.id);
  ok(res, {});
});

app.delete("/api/pf/entradas/:id", (req, res) => {
  db.prepare("DELETE FROM pf_entradas WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── PLUGGY / OPEN FINANCE ───────────────────────────────────────────────────

const PLUGGY_CLIENT_ID = process.env.PLUGGY_CLIENT_ID || "";
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET || "";
const PLUGGY_BASE = "https://api.pluggy.ai";

async function pluggyAuth() {
  if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) throw new Error("Credenciais Pluggy não configuradas");
  const r = await fetch(`${PLUGGY_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`Pluggy auth error: ${r.status}`);
  const d = await r.json();
  return d.apiKey;
}

// Connect token para o widget Pluggy Connect
app.post("/api/pf/pluggy/connect-token", async (req, res) => {
  try {
    const apiKey = await pluggyAuth();
    const { itemId } = req.body; // para reconexão de item existente
    const body = {};
    if (itemId) body.itemId = itemId;
    const r = await fetch(`${PLUGGY_BASE}/connect_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    ok(res, { accessToken: d.accessToken });
  } catch (e) {
    err(res, e.message);
  }
});

// Lista items salvos no banco
app.get("/api/pf/pluggy/items", (req, res) => {
  const items = db.prepare("SELECT * FROM pf_pluggy_items ORDER BY criado_em DESC").all();
  ok(res, items);
});

// Salva novo item após conexão via widget
app.post("/api/pf/pluggy/items", async (req, res) => {
  try {
    const { itemId, titular } = req.body;
    if (!itemId) return err(res, "itemId obrigatório");
    const apiKey = await pluggyAuth();
    const r = await fetch(`${PLUGGY_BASE}/items/${itemId}`, {
      headers: { "X-API-KEY": apiKey },
    });
    if (!r.ok) return err(res, "Item não encontrado no Pluggy");
    const item = await r.json();
    db.prepare(`
      INSERT INTO pf_pluggy_items (item_id, titular, connector_name, connector_type, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        connector_name=excluded.connector_name,
        status=excluded.status,
        atualizado_em=CURRENT_TIMESTAMP
    `).run(
      itemId,
      titular || "Ramon",
      item.connector?.name || "",
      item.connector?.type || "",
      item.status || "UPDATED"
    );
    ok(res, { itemId, connector: item.connector?.name });
  } catch (e) {
    err(res, e.message);
  }
});

// Remove item (desconectar banco)
app.delete("/api/pf/pluggy/items/:itemId", async (req, res) => {
  try {
    const { itemId } = req.params;
    const apiKey = await pluggyAuth();
    // Deleta no Pluggy
    await fetch(`${PLUGGY_BASE}/items/${itemId}`, {
      method: "DELETE",
      headers: { "X-API-KEY": apiKey },
    });
    db.prepare("DELETE FROM pf_pluggy_items WHERE item_id=?").run(itemId);
    db.prepare("UPDATE pf_contas SET pluggy_item_id=NULL, pluggy_account_id=NULL WHERE pluggy_item_id=?").run(itemId);
    ok(res, {});
  } catch (e) {
    err(res, e.message);
  }
});

// Sincroniza dados (contas + transações + investimentos) de todos os items
app.post("/api/pf/pluggy/sync", async (req, res) => {
  try {
    const apiKey = await pluggyAuth();
    const items = db.prepare("SELECT * FROM pf_pluggy_items").all();
    let totalTransacoes = 0, totalInvestimentos = 0;

    for (const item of items) {
      // 1. Atualiza status do item
      const itemR = await fetch(`${PLUGGY_BASE}/items/${item.item_id}`, {
        headers: { "X-API-KEY": apiKey },
      });
      if (!itemR.ok) continue;
      const itemData = await itemR.json();
      db.prepare("UPDATE pf_pluggy_items SET status=?, atualizado_em=CURRENT_TIMESTAMP WHERE item_id=?")
        .run(itemData.status, item.item_id);

      // 2. Sincroniza contas bancárias
      const accR = await fetch(`${PLUGGY_BASE}/accounts?itemId=${item.item_id}`, {
        headers: { "X-API-KEY": apiKey },
      });
      if (accR.ok) {
        const { results: accounts } = await accR.json();
        for (const acc of (accounts || [])) {
          // Verifica se já tem uma pf_conta vinculada
          const existing = db.prepare("SELECT id FROM pf_contas WHERE pluggy_account_id=?").get(acc.id);
          if (!existing) {
            // Cria conta automaticamente
            db.prepare(`
              INSERT INTO pf_contas (nome, banco, tipo, titular, saldo_inicial, pluggy_item_id, pluggy_account_id)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              acc.name || acc.type,
              itemData.connector?.name || "",
              acc.type === "CREDIT" ? "cartao" : acc.subtype === "SAVINGS_ACCOUNT" ? "poupanca" : "corrente",
              item.titular,
              acc.balance || 0,
              item.item_id,
              acc.id
            );
          } else {
            // Atualiza saldo
            db.prepare("UPDATE pf_contas SET saldo_inicial=? WHERE pluggy_account_id=?")
              .run(acc.balance || 0, acc.id);
          }

          // 3. Sincroniza transações dos últimos 90 dias
          const desde = new Date();
          desde.setDate(desde.getDate() - 90);
          const fromDate = desde.toISOString().split("T")[0];
          const toDate = new Date().toISOString().split("T")[0];

          let page = 1;
          while (true) {
            const txR = await fetch(
              `${PLUGGY_BASE}/transactions?accountId=${acc.id}&from=${fromDate}&to=${toDate}&pageSize=500&page=${page}`,
              { headers: { "X-API-KEY": apiKey } }
            );
            if (!txR.ok) break;
            const txData = await txR.json();
            const txs = txData.results || [];
            if (txs.length === 0) break;

            const contaId = existing?.id || db.prepare("SELECT id FROM pf_contas WHERE pluggy_account_id=?").get(acc.id)?.id;
            for (const tx of txs) {
              db.prepare(`
                INSERT OR IGNORE INTO pf_transacoes
                  (conta_id, data, descricao, valor, tipo, categoria, origem, pluggy_id)
                VALUES (?, ?, ?, ?, ?, ?, 'pluggy', ?)
              `).run(
                contaId,
                tx.date?.split("T")[0] || toDate,
                tx.description || tx.descriptionRaw || "",
                Math.abs(tx.amount || 0),
                (tx.amount || 0) < 0 ? "saida" : "entrada",
                tx.category || "",
                tx.id
              );
              totalTransacoes++;
            }
            if (!txData.nextPage) break;
            page++;
          }
        }
      }

      // 4. Sincroniza investimentos
      const invR = await fetch(`${PLUGGY_BASE}/investments?itemId=${item.item_id}`, {
        headers: { "X-API-KEY": apiKey },
      });
      if (invR.ok) {
        const { results: investments } = await invR.json();
        for (const inv of (investments || [])) {
          db.prepare(`
            INSERT INTO pf_investimentos
              (pluggy_id, item_id, titular, nome, tipo, subtipo, codigo,
               valor_atual, valor_aplicado, rentabilidade_total, rentabilidade_anual,
               data_vencimento, data_atualizacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(pluggy_id) DO UPDATE SET
              valor_atual=excluded.valor_atual,
              valor_aplicado=excluded.valor_aplicado,
              rentabilidade_total=excluded.rentabilidade_total,
              rentabilidade_anual=excluded.rentabilidade_anual,
              data_atualizacao=excluded.data_atualizacao
          `).run(
            inv.id,
            item.item_id,
            item.titular,
            inv.name || "",
            inv.type || "",
            inv.subtype || "",
            inv.code || "",
            inv.value || 0,
            inv.amount || 0,
            inv.totalGrossAmount ? ((inv.value - inv.amount) / inv.amount) * 100 : null,
            inv.annualRate || null,
            inv.date?.split("T")[0] || null,
            new Date().toISOString().split("T")[0]
          );
          totalInvestimentos++;
        }
      }
    }

    ok(res, { sincronizados: items.length, transacoes: totalTransacoes, investimentos: totalInvestimentos });
  } catch (e) {
    err(res, e.message);
  }
});

// Lista investimentos
app.get("/api/pf/investimentos", (req, res) => {
  const { titular } = req.query;
  let q = "SELECT * FROM pf_investimentos";
  const params = [];
  if (titular) { q += " WHERE titular=?"; params.push(titular); }
  q += " ORDER BY valor_atual DESC";
  ok(res, db.prepare(q).all(...params));
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`CRM R2X rodando em http://localhost:${PORT}`));
