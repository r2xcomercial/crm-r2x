require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
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
    SELECT nome, telefone, aniversario, 'lead' as tipo FROM leads
    WHERE strftime('%m', aniversario) = strftime('%m','now') AND aniversario IS NOT NULL
    UNION ALL
    SELECT nome, telefone, aniversario, 'corretor' as tipo FROM corretores
    WHERE strftime('%m', aniversario) = strftime('%m','now') AND aniversario IS NOT NULL
    UNION ALL
    SELECT nome_contato as nome, telefone, aniversario, 'cliente' as tipo FROM clientes
    WHERE strftime('%m', aniversario) = strftime('%m','now') AND aniversario IS NOT NULL
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

    // Lê como array de arrays e detecta linha de cabeçalho automaticamente
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
      for (const n of names) {
        const i = headers.indexOf(norm(n));
        if (i !== -1) return i;
      }
      // busca parcial
      for (const n of names) {
        const i = headers.findIndex(h => h && h.includes(norm(n)));
        if (i !== -1) return i;
      }
      return -1;
    };

    const iLote = idx('LOTE', 'LT', 'APARTAMENTO', 'APTO', 'UNIDADE');
    const iQuadra = idx('QUADRA', 'QD', 'ANDAR');
    const iArea = idx('AREA_M2', 'AREA', 'ÁREA', 'AREA PRIVATIVA');
    const iPreco = idx('PRECO', 'PREÇO DO LOTE', 'PRECO DO LOTE', 'VALOR', 'PREÇO');
    const iTipologia = idx('TIPOLOGIA', 'TIPO');

    const empId = parseInt(req.params.id);
    const insert = db.prepare(`INSERT INTO unidades (empreendimento_id,quadra,lote,area_m2,preco,status) VALUES (?,?,?,?,?,?)`);

    // Limpa unidades disponíveis existentes antes de reimportar
    db.prepare("DELETE FROM unidades WHERE empreendimento_id=? AND status='disponivel'").run(empId);

    let importadas = 0;
    const insertMany = db.transaction(() => {
      for (let i = headerRow + 1; i < aoa.length; i++) {
        const row = aoa[i] || [];
        let lote = iLote >= 0 ? String(row[iLote]||'').trim() : '';
        if (!lote || lote === 'null') continue;
        // Acrescenta tipologia ao lote (ex: "401 - 2 dorms")
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
    const rows = { length: importadas };

    const stats = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(preco),0) as vgv FROM unidades WHERE empreendimento_id=?").get(empId);

    // Atualiza VGV e nº de unidades do empreendimento automaticamente
    db.prepare("UPDATE empreendimentos SET vgv_estimado=?, num_unidades=? WHERE id=?").run(stats.vgv, stats.total, empId);

    ok(res, { importadas: rows.length, total: stats.total, vgv_total: stats.vgv });
  } catch (e) {
    err(res, "Erro ao processar arquivo: " + e.message);
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

// Endpoint público — cadastro via link (sem autenticação)
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

// Webhook para receber leads do chatbot WhatsApp
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

// Helper: gera/atualiza entrada financeira de comissão de uma venda
function sincronizarComissaoVenda(vendaId) {
  const v = db.prepare("SELECT * FROM vendas WHERE id=?").get(vendaId);
  if (!v) return null;

  // Remove entrada antiga vinculada
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

  // Atualiza valores na venda também
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

  // Se mudou unidade, libera a anterior e marca a nova
  if (vendaAntiga?.unidade_id && vendaAntiga.unidade_id != unidade_id) {
    db.prepare("UPDATE unidades SET status='disponivel' WHERE id=?").run(vendaAntiga.unidade_id);
  }
  if (unidade_id) db.prepare("UPDATE unidades SET status=? WHERE id=?").run(status === 'distrato' ? 'disponivel' : 'vendido', unidade_id);

  // Recalcula comissão (cria, atualiza ou remove dependendo do estado)
  const comissao = sincronizarComissaoVenda(req.params.id);
  ok(res, { comissao_r2x: comissao });
});

app.delete("/api/vendas/:id", (req, res) => {
  const v = db.prepare("SELECT unidade_id FROM vendas WHERE id=?").get(req.params.id);
  // Remove entradas financeiras vinculadas
  db.prepare("DELETE FROM financeiro_entradas WHERE venda_id=?").run(req.params.id);
  // Libera unidade
  if (v?.unidade_id) db.prepare("UPDATE unidades SET status='disponivel' WHERE id=?").run(v.unidade_id);
  db.prepare("DELETE FROM vendas WHERE id=?").run(req.params.id);
  ok(res, {});
});

// Ranking corretores
app.get("/api/vendas/ranking", (req, res) => {
  const { empreendimento_id, periodo } = req.query;
  let sql = `
    SELECT c.nome, c.imobiliaria, COUNT(v.id) as vendas, COALESCE(SUM(v.valor),0) as vgv
    FROM vendas v JOIN corretores c ON c.id=v.corretor_id
    WHERE v.status='ativo'
  `;
  const params = [];
  if (empreendimento_id) { sql += " AND v.empreendimento_id=?"; params.push(empreendimento_id); }
  if (periodo === 'mes') { sql += " AND strftime('%Y-%m',v.data_venda)=strftime('%Y-%m','now')"; }
  sql += " GROUP BY c.id ORDER BY vgv DESC LIMIT 20";
  ok(res, db.prepare(sql).all(...params));
});

// ─── FINANCEIRO ENTRADAS ──────────────────────────────────────────────────────

app.get("/api/financeiro/entradas", (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, e.nome as empreendimento_nome
    FROM financeiro_entradas f
    LEFT JOIN empreendimentos e ON e.id = f.empreendimento_id
    ORDER BY f.data_prevista DESC
  `).all();
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
  const rows = db.prepare(`
    SELECT f.*, e.nome as empreendimento_nome
    FROM financeiro_saidas f
    LEFT JOIN empreendimentos e ON e.id = f.empreendimento_id
    ORDER BY f.data_pagamento DESC
  `).all();
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
  const rows = db.prepare(`
    SELECT l.*, e.nome as empreendimento_nome
    FROM lancamentos_calendario l
    LEFT JOIN empreendimentos e ON e.id = l.empreendimento_id
    ORDER BY l.data
  `).all();
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

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`CRM R2X rodando em http://localhost:${PORT}`));
