require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const crypto = require("crypto");
const db = require("./database");
const OpenAI = require("openai");
const pdfParse = require("pdf-parse");

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }); // 8 MB máx

const app = express();
app.use(cors());
app.use(express.json());

// ─── AUTENTICAÇÃO MULTI-USUÁRIO ──────────────────────────────────────────────

function gerarSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashSenha(senha, salt) { return crypto.pbkdf2Sync(senha, salt, 10000, 64, 'sha512').toString('hex'); }
function gerarToken() { return crypto.randomBytes(32).toString('hex'); }

const APIs_PUBLICAS = ["/api/corretores/publico", "/api/leads/whatsapp", "/api/auth/login", "/api/webhook/lead", "/api/portal/", "/api/pluggy/webhook"];

function autenticar(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (APIs_PUBLICAS.some(p => req.path.startsWith(p))) return next();
  const token = req.headers["x-crm-token"] || req.query.token;
  if (!token) return res.status(401).json({ ok: false, error: "Não autorizado" });
  const sessao = db.prepare(`
    SELECT s.token, u.id, u.nome, u.email, u.perfil, u.corretor_id, u.cliente_id
    FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token=? AND s.expira_em > datetime('now') AND u.ativo=1
  `).get(token);
  if (!sessao) return res.status(401).json({ ok: false, error: "Sessão inválida ou expirada" });
  req.usuario = { id: sessao.id, nome: sessao.nome, email: sessao.email, perfil: sessao.perfil, corretor_id: sessao.corretor_id, cliente_id: sessao.cliente_id };
  next();
}

app.use(autenticar);

// Incorporador só pode acessar /api/auth/* e /api/incorporador/*
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.usuario?.perfil === 'incorporador') {
    const permitido = req.path.startsWith('/api/auth/') || req.path.startsWith('/api/incorporador/');
    if (!permitido) return err(res, 'Acesso não autorizado', 403);
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Rotas sem extensão → arquivos HTML correspondentes
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

const PORT = process.env.PORT || 4000;

// Cria admin padrão se não existir nenhum usuário
(function seedAdmin() {
  const existe = db.prepare('SELECT id FROM usuarios LIMIT 1').get();
  if (!existe) {
    const salt = gerarSalt();
    db.prepare('INSERT INTO usuarios(nome, email, senha_hash, salt, perfil) VALUES(?,?,?,?,?)')
      .run('Administrador', process.env.CRM_USER || 'r2x', hashSenha(process.env.CRM_PASS || 'r2x2026', salt), salt, 'admin');
    console.log('[auth] Usuário admin criado — login:', process.env.CRM_USER || 'r2x');
  }
})();

// ─── UTILS ───────────────────────────────────────────────────────────────────

function ok(res, data) { res.json({ ok: true, data }); }
function err(res, msg, code = 400) { res.status(code).json({ ok: false, error: msg }); }

// ─── AUTH ────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return err(res, 'Email e senha obrigatórios');
  const u = db.prepare('SELECT * FROM usuarios WHERE email=? AND ativo=1').get(email.trim());
  if (!u || hashSenha(senha, u.salt) !== u.senha_hash) return err(res, 'Credenciais inválidas', 401);
  const token = gerarToken();
  const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T',' ').slice(0,19);
  db.prepare('INSERT INTO sessoes(token, usuario_id, expira_em) VALUES(?,?,?)').run(token, u.id, expira);
  db.prepare("DELETE FROM sessoes WHERE expira_em < datetime('now')").run();
  ok(res, { token, nome: u.nome, email: u.email, perfil: u.perfil, corretor_id: u.corretor_id, cliente_id: u.cliente_id });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers["x-crm-token"] || req.query.token;
  if (token) db.prepare('DELETE FROM sessoes WHERE token=?').run(token);
  ok(res, {});
});

app.get('/api/auth/me', (req, res) => {
  ok(res, req.usuario);
});

// ─── USUÁRIOS (admin only) ────────────────────────────────────────────────────

function soAdmin(req, res, next) {
  if (req.usuario?.perfil !== 'admin') return err(res, 'Acesso restrito a administradores', 403);
  next();
}

app.get('/api/usuarios', soAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.nome, u.email, u.perfil, u.corretor_id, u.cliente_id, u.ativo, u.criado_em,
           c.nome as corretor_nome, cl.razao_social as cliente_nome
    FROM usuarios u
    LEFT JOIN corretores c ON c.id = u.corretor_id
    LEFT JOIN clientes cl ON cl.id = u.cliente_id
    ORDER BY u.nome
  `).all();
  ok(res, rows);
});

app.post('/api/usuarios', soAdmin, (req, res) => {
  const { nome, email, senha, perfil, corretor_id, cliente_id } = req.body;
  if (!nome || !email || !senha) return err(res, 'Nome, email e senha obrigatórios');
  const salt = gerarSalt();
  const hash = hashSenha(senha, salt);
  try {
    const r = db.prepare('INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,corretor_id,cliente_id) VALUES(?,?,?,?,?,?,?)').run(nome, email, hash, salt, perfil||'corretor', corretor_id||null, cliente_id||null);
    ok(res, { id: r.lastInsertRowid });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return err(res, 'E-mail já cadastrado');
    throw e;
  }
});

app.put('/api/usuarios/:id', soAdmin, (req, res) => {
  const { nome, email, senha, perfil, corretor_id, cliente_id, ativo } = req.body;
  const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(parseInt(req.params.id));
  if (!u) return err(res, 'Usuário não encontrado', 404);
  let hash = u.senha_hash, salt = u.salt;
  if (senha) { salt = gerarSalt(); hash = hashSenha(senha, salt); }
  db.prepare('UPDATE usuarios SET nome=?,email=?,senha_hash=?,salt=?,perfil=?,corretor_id=?,cliente_id=?,ativo=? WHERE id=?')
    .run(nome||u.nome, email||u.email, hash, salt, perfil||u.perfil, corretor_id??u.corretor_id, cliente_id??u.cliente_id, ativo??u.ativo, u.id);
  ok(res, {});
});

app.delete('/api/usuarios/:id', soAdmin, (req, res) => {
  db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(parseInt(req.params.id));
  db.prepare('DELETE FROM usuarios WHERE id=?').run(parseInt(req.params.id));
  ok(res, {});
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

app.get("/api/dashboard", (req, res) => {
  const leads_total = db.prepare("SELECT COUNT(*) as n FROM leads").get().n;
  const leads_novos = db.prepare("SELECT COUNT(*) as n FROM leads WHERE status='novo' OR (status NOT IN ('com_corretor','vendido','sem_venda','qualificado','visitou','proposta','perdido'))").get().n;
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

  // Consolida status legados nos novos grupos do Kanban
  const funil = db.prepare(`
    SELECT
      CASE status
        WHEN 'qualificado' THEN 'com_corretor'
        WHEN 'visitou'     THEN 'com_corretor'
        WHEN 'proposta'    THEN 'com_corretor'
        WHEN 'perdido'     THEN 'sem_venda'
        ELSE status
      END as status,
      COUNT(*) as n
    FROM leads
    GROUP BY 1
    ORDER BY CASE
      WHEN status='novo'         THEN 1
      WHEN status='com_corretor'
        OR status IN ('qualificado','visitou','proposta') THEN 2
      WHEN status='vendido'      THEN 3
      WHEN status='sem_venda'
        OR status='perdido'      THEN 4
      ELSE 5
    END
  `).all();

  const leads_esquecidos = db.prepare(`
    SELECT id, nome, telefone, status, atualizado_em,
      CAST(julianday('now') - julianday(atualizado_em) AS INTEGER) as dias
    FROM leads
    WHERE status NOT IN ('vendido','perdido')
    AND julianday('now') - julianday(atualizado_em) >= 3
    ORDER BY atualizado_em ASC
    LIMIT 10
  `).all();

  // Follow-ups com data de retorno vencida (lead ainda ativo, follow-up mais recente do lead)
  const followups_vencidos = db.prepare(`
    SELECT f.id, f.tipo, f.descricao, f.data_retorno,
           l.id as lead_id, l.nome as lead_nome, l.telefone as lead_telefone, l.status as lead_status
    FROM followups f
    JOIN leads l ON l.id = f.lead_id
    WHERE f.data_retorno IS NOT NULL
      AND date(f.data_retorno) < date('now')
      AND l.status NOT IN ('vendido','perdido')
      AND f.id = (SELECT MAX(f2.id) FROM followups f2 WHERE f2.lead_id = f.lead_id AND f2.data_retorno IS NOT NULL)
    ORDER BY f.data_retorno ASC
    LIMIT 15
  `).all();

  // Follow-ups agendados para hoje
  const followups_hoje = db.prepare(`
    SELECT f.id, f.tipo, f.descricao, f.data_retorno,
           l.id as lead_id, l.nome as lead_nome, l.telefone as lead_telefone
    FROM followups f
    JOIN leads l ON l.id = f.lead_id
    WHERE date(f.data_retorno) = date('now')
      AND l.status NOT IN ('vendido','perdido')
    ORDER BY f.criado_em DESC
    LIMIT 15
  `).all();

  // Aniversários hoje e esta semana
  const aniversarios_hoje = db.prepare(`
    SELECT nome, telefone, 'lead' as tipo FROM leads
    WHERE strftime('%m-%d', aniversario) = strftime('%m-%d','now') AND aniversario IS NOT NULL
    UNION ALL
    SELECT nome, telefone, 'corretor' as tipo FROM corretores
    WHERE strftime('%m-%d', aniversario) = strftime('%m-%d','now') AND aniversario IS NOT NULL
    UNION ALL
    SELECT nome_contato as nome, telefone, 'cliente' as tipo FROM clientes
    WHERE strftime('%m-%d', aniversario) = strftime('%m-%d','now') AND aniversario IS NOT NULL
  `).all();

  ok(res, {
    kpis: { leads_total, leads_novos, vendas_mes, vendas_total, entradas_pendentes, clientes_total, corretores_ativos, corretores_total, corretores_com_vendas, empreendimentos },
    aniversarios_mes,
    aniversarios_hoje,
    proximos_lancamentos,
    funil,
    ranking_vgv,
    ranking_qtd,
    leads_esquecidos,
    followups_vencidos,
    followups_hoje,
  });
});

// ─── CLIENTES ────────────────────────────────────────────────────────────────

app.get("/api/clientes", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(e.id) as total_empreendimentos,
           u.id as usuario_id, u.email as usuario_email, u.ativo as usuario_ativo
    FROM clientes c
    LEFT JOIN empreendimentos e ON e.cliente_id = c.id
    LEFT JOIN usuarios u ON u.cliente_id = c.id
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

// Lucratividade por empreendimento (receitas - despesas)
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
    SELECT e.*, c.razao_social as cliente_nome,
      EXISTS(SELECT 1 FROM mapas m WHERE m.empreendimento_id = e.id) as tem_mapa
    FROM empreendimentos e LEFT JOIN clientes c ON c.id = e.cliente_id
    ORDER BY e.nome
  `).all();
  ok(res, rows);
});

app.post("/api/empreendimentos", (req, res) => {
  const { cliente_id, nome, tipo, endereco, cidade, estado, num_unidades, vgv_estimado, status, data_lancamento, data_inicio_vendas, observacoes, percentual_r2x } = req.body;
  if (!nome) return err(res, "Nome obrigatório");
  const r = db.prepare(`INSERT INTO empreendimentos (cliente_id,nome,tipo,endereco,cidade,estado,num_unidades,vgv_estimado,status,data_lancamento,data_inicio_vendas,observacoes,percentual_r2x) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(cliente_id, nome, tipo || 'loteamento', endereco, cidade, estado, num_unidades, vgv_estimado, status || 'prospecto', data_lancamento, data_inicio_vendas, observacoes, percentual_r2x || null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/empreendimentos/:id", (req, res) => {
  const { cliente_id, nome, tipo, endereco, cidade, estado, num_unidades, vgv_estimado, status, data_lancamento, data_inicio_vendas, observacoes, percentual_r2x } = req.body;
  db.prepare(`UPDATE empreendimentos SET cliente_id=?,nome=?,tipo=?,endereco=?,cidade=?,estado=?,num_unidades=?,vgv_estimado=?,status=?,data_lancamento=?,data_inicio_vendas=?,observacoes=?,percentual_r2x=? WHERE id=?`).run(cliente_id, nome, tipo || 'loteamento', endereco, cidade, estado, num_unidades, vgv_estimado, status, data_lancamento, data_inicio_vendas, observacoes, percentual_r2x || null, req.params.id);
  ok(res, {});
});

// ─── UNIDADES ─────────────────────────────────────────────────────────────────

app.get("/api/empreendimentos/:id/unidades", (req, res) => {
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM vagas_garagem vg WHERE vg.unidade_id = u.id) as num_vagas
    FROM unidades u
    WHERE u.empreendimento_id = ?
    ORDER BY u.quadra, u.lote
  `).all(req.params.id);
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

// Gera contrato DOCX preenchido com dados do empreendimento e incorporador
app.get("/api/empreendimentos/:id/contrato", (req, res) => {
  try {
    const empId = parseInt(req.params.id);
    const emp = db.prepare("SELECT * FROM empreendimentos WHERE id=?").get(empId);
    if (!emp) return err(res, "Empreendimento não encontrado");
    const cliente = emp.cliente_id ? db.prepare("SELECT * FROM clientes WHERE id=?").get(emp.cliente_id) : {};

    // Converte valor para texto por extenso (simplificado para percentuais usuais)
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

// Atualiza status de uma unidade (disponivel / reservado / vendido)
app.put("/api/unidades/:id/status", (req, res) => {
  const { status } = req.body;
  if (!['disponivel','reservado','vendido'].includes(status)) return err(res, "Status inválido");
  db.prepare("UPDATE unidades SET status=? WHERE id=?").run(status, req.params.id);
  ok(res, {});
});

app.delete("/api/unidades/:id", (req, res) => {
  const unidadeId = parseInt(req.params.id);
  const u = db.prepare("SELECT * FROM unidades WHERE id=?").get(unidadeId);
  if (!u) return err(res, "Unidade não encontrada", 404);
  db.prepare("DELETE FROM unidades WHERE id=?").run(unidadeId);
  // Atualiza contadores do empreendimento
  const stats = db.prepare("SELECT COUNT(*) as total, COALESCE(SUM(preco),0) as vgv FROM unidades WHERE empreendimento_id=?").get(u.empreendimento_id);
  db.prepare("UPDATE empreendimentos SET num_unidades=?, vgv_estimado=? WHERE id=?").run(stats.total, stats.vgv, u.empreendimento_id);
  ok(res, {});
});

app.delete("/api/empreendimentos/:id/unidades", (req, res) => {
  db.prepare("DELETE FROM unidades WHERE empreendimento_id=? AND status='disponivel'").run(req.params.id);
  ok(res, {});
});

app.delete("/api/empreendimentos/:id", (req, res) => {
  db.prepare("DELETE FROM empreendimentos WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── VAGAS DE GARAGEM ─────────────────────────────────────────────────────────

app.get("/api/empreendimentos/:id/vagas", (req, res) => {
  const rows = db.prepare(`
    SELECT vg.*,
      v.id as venda_ref_id,
      l.nome as comprador,
      v.imovel,
      u.lote as unidade_lote,
      u.quadra as unidade_quadra
    FROM vagas_garagem vg
    LEFT JOIN vendas v ON v.id = vg.venda_id AND v.status = 'ativo'
    LEFT JOIN leads l ON l.id = v.lead_id
    LEFT JOIN unidades u ON u.id = vg.unidade_id
    WHERE vg.empreendimento_id = ?
    ORDER BY vg.pavimento, vg.numero
  `).all(req.params.id);
  ok(res, rows);
});

// Vagas vinculadas a uma unidade específica
app.get("/api/unidades/:id/vagas", (req, res) => {
  const rows = db.prepare(`SELECT * FROM vagas_garagem WHERE unidade_id=? ORDER BY numero`).all(req.params.id);
  ok(res, rows);
});

// Vincular/desvincular vaga de uma unidade
app.put("/api/vagas/:id/unidade", (req, res) => {
  const { unidade_id } = req.body;
  const vaga = db.prepare("SELECT * FROM vagas_garagem WHERE id=?").get(req.params.id);
  if (!vaga) return err(res, "Vaga não encontrada", 404);
  db.prepare("UPDATE vagas_garagem SET unidade_id=? WHERE id=?").run(unidade_id||null, req.params.id);
  ok(res, {});
});

app.post("/api/empreendimentos/:id/vagas", (req, res) => {
  const { numero, box, bloco, tipo, tamanho, pavimento, preco, observacoes, unidade_id } = req.body;
  if (!numero) return err(res, "Número da vaga é obrigatório");
  const r = db.prepare(`
    INSERT INTO vagas_garagem (empreendimento_id, numero, box, bloco, tipo, tamanho, pavimento, preco, observacoes, unidade_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(req.params.id, numero, box||null, bloco||null, tipo||'simples', tamanho||null, pavimento||null, preco||null, observacoes||null, unidade_id||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/vagas/:id", (req, res) => {
  const { numero, box, bloco, tipo, tamanho, pavimento, preco, status, observacoes, unidade_id } = req.body;
  const vaga = db.prepare("SELECT * FROM vagas_garagem WHERE id=?").get(req.params.id);
  if (!vaga) return err(res, "Vaga não encontrada", 404);
  db.prepare(`UPDATE vagas_garagem SET numero=?, box=?, bloco=?, tipo=?, tamanho=?, pavimento=?, preco=?, status=?, observacoes=?, unidade_id=? WHERE id=?`)
    .run(numero||vaga.numero, box||null, bloco||null, tipo||vaga.tipo, tamanho||null, pavimento||null, preco||null, status||vaga.status, observacoes||null, unidade_id??vaga.unidade_id, req.params.id);
  ok(res, {});
});

app.delete("/api/vagas/:id", (req, res) => {
  const vaga = db.prepare("SELECT * FROM vagas_garagem WHERE id=?").get(req.params.id);
  if (!vaga) return err(res, "Vaga não encontrada", 404);
  if (vaga.status === 'vendida') return err(res, "Não é possível excluir uma vaga vendida. Cancele a venda primeiro.");
  db.prepare("DELETE FROM vagas_garagem WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── CORRETORES ───────────────────────────────────────────────────────────────

app.get("/api/corretores", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, COUNT(v.id) as total_vendas, COALESCE(SUM(v.valor),0) as vgv_vendido,
           u.id as usuario_id, u.email as usuario_email, u.ativo as usuario_ativo
    FROM corretores c
    LEFT JOIN vendas v ON v.corretor_id = c.id AND v.status='ativo'
    LEFT JOIN usuarios u ON u.corretor_id = c.id
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
  if (req.usuario?.perfil === 'corretor' && req.usuario?.corretor_id) {
    sql += " AND l.corretor_id=?"; params.push(req.usuario.corretor_id);
  }
  if (status) { sql += " AND l.status=?"; params.push(status); }
  if (empreendimento_id) { sql += " AND l.empreendimento_id=?"; params.push(empreendimento_id); }
  sql += " ORDER BY l.criado_em DESC";
  ok(res, db.prepare(sql).all(...params));
});

app.post("/api/leads", (req, res) => {
  const { nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, origem, observacoes, aniversario, tipo, creci, imobiliaria } = req.body;
  const r = db.prepare(`INSERT INTO leads (nome,telefone,email,cidade,objetivo,faixa_investimento,prazo,empreendimento_interesse,empreendimento_id,corretor_id,status,origem,observacoes,aniversario,tipo,creci,imobiliaria) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status || 'novo', origem || 'manual', observacoes, aniversario||null, tipo||null, creci||null, imobiliaria||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/leads/:id", (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return err(res, "Lead não encontrado", 404);
  const b = req.body;
  // Merge: usa valor do body se explicitamente enviado, senão mantém o valor atual
  const val = (key, fallback) => key in b ? b[key] : (lead[key] !== undefined ? lead[key] : fallback);
  // Auto-move para com_corretor quando corretor é atribuído (exceto vendido/sem_venda)
  const corretor_id = val('corretor_id', null);
  let novoStatus = val('status', lead.status);
  if (corretor_id && !['vendido','sem_venda'].includes(lead.status) && lead.status !== 'com_corretor') {
    novoStatus = 'com_corretor';
  }
  db.prepare(`UPDATE leads SET nome=?,telefone=?,email=?,cidade=?,objetivo=?,faixa_investimento=?,prazo=?,empreendimento_interesse=?,empreendimento_id=?,corretor_id=?,status=?,observacoes=?,aniversario=?,tipo=?,creci=?,imobiliaria=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).run(
    val('nome', null), val('telefone', null), val('email', null), val('cidade', null),
    val('objetivo', null), val('faixa_investimento', null), val('prazo', null),
    val('empreendimento_interesse', null), val('empreendimento_id', null),
    corretor_id, novoStatus, val('observacoes', null),
    val('aniversario', null), val('tipo', null), val('creci', null), val('imobiliaria', null),
    req.params.id
  );
  ok(res, {});
});

app.delete("/api/leads/:id", (req, res) => {
  db.prepare("DELETE FROM leads WHERE id=?").run(req.params.id);
  ok(res, {});
});

// Converter lead-corretor em parceiro (cria registro em corretores)
app.post("/api/leads/:id/converter-corretor", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);
  if (!lead) return err(res, "Lead não encontrado", 404);
  const r = db.prepare(`
    INSERT INTO corretores (nome, telefone, email, cidade, creci, imobiliaria, ativo)
    VALUES (?,?,?,?,?,?,1)
  `).run(lead.nome||'', lead.telefone||null, lead.email||null, lead.cidade||null, lead.creci||null, lead.imobiliaria||null);
  // Marca lead como qualificado e registra que virou parceiro
  db.prepare("UPDATE leads SET tipo='corretor', status='com_corretor', atualizado_em=CURRENT_TIMESTAMP WHERE id=?").run(lead.id);
  ok(res, { corretor_id: r.lastInsertRowid });
});

// Follow-ups de leads
app.get("/api/leads/:id/followups", (req, res) => {
  const rows = db.prepare("SELECT * FROM followups WHERE lead_id=? ORDER BY criado_em DESC").all(req.params.id);
  ok(res, rows);
});

app.post("/api/leads/:id/followups", (req, res) => {
  const { tipo, descricao, data_retorno } = req.body;
  if (!tipo) return err(res, "Tipo obrigatório");
  const r = db.prepare("INSERT INTO followups (lead_id,tipo,descricao,data_retorno) VALUES (?,?,?,?)").run(req.params.id, tipo, descricao || null, data_retorno || null);
  db.prepare("UPDATE leads SET atualizado_em=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  ok(res, { id: r.lastInsertRowid });
});

// ─── HISTÓRICO DE INTERAÇÕES COM LEAD ────────────────────────────────────────

app.get('/api/leads/:id/interacoes', (req, res) => {
  const rows = db.prepare('SELECT * FROM interacoes WHERE lead_id=? ORDER BY criado_em DESC').all(parseInt(req.params.id));
  ok(res, rows);
});

app.post('/api/leads/:id/interacoes', (req, res) => {
  const { tipo, descricao } = req.body;
  if (!descricao) return err(res, 'Descrição obrigatória');
  const r = db.prepare('INSERT INTO interacoes(lead_id,tipo,descricao,usuario_nome) VALUES(?,?,?,?)').run(parseInt(req.params.id), tipo||'nota', descricao, req.usuario?.nome||'Sistema');
  ok(res, { id: r.lastInsertRowid });
});

app.delete('/api/interacoes/:id', (req, res) => {
  db.prepare('DELETE FROM interacoes WHERE id=?').run(parseInt(req.params.id));
  ok(res, {});
});

// ─── VISITAS ──────────────────────────────────────────────────────────────────

app.get('/api/leads/:id/visitas', (req, res) => {
  const rows = db.prepare('SELECT v.*, c.nome as corretor_nome, e.nome as emp_nome FROM visitas v LEFT JOIN corretores c ON c.id=v.corretor_id LEFT JOIN empreendimentos e ON e.id=v.empreendimento_id WHERE v.lead_id=? ORDER BY v.data_visita DESC').all(parseInt(req.params.id));
  ok(res, rows);
});

app.post('/api/leads/:id/visitas', (req, res) => {
  const { corretor_id, empreendimento_id, data_visita, unidade_interesse, proximo_passo, observacoes } = req.body;
  if (!data_visita) return err(res, 'Data da visita obrigatória');
  const r = db.prepare('INSERT INTO visitas(lead_id,corretor_id,empreendimento_id,data_visita,unidade_interesse,proximo_passo,observacoes) VALUES(?,?,?,?,?,?,?)').run(parseInt(req.params.id), corretor_id||null, empreendimento_id||null, data_visita, unidade_interesse||null, proximo_passo||null, observacoes||null);
  ok(res, { id: r.lastInsertRowid });
});

app.delete('/api/visitas/:id', (req, res) => {
  db.prepare('DELETE FROM visitas WHERE id=?').run(parseInt(req.params.id));
  ok(res, {});
});

// Webhook para receber leads do chatbot WhatsApp
app.post("/api/leads/whatsapp", (req, res) => {
  const { telefone, nome, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, tipo, score, resumo } = req.body;
  if (!telefone) return err(res, "Telefone obrigatório");
  const existente = db.prepare("SELECT id, status FROM leads WHERE telefone=?").get(telefone);
  if (existente) {
    let novoStatus = existente.status;
    if (score >= 60 && existente.status === 'novo') novoStatus = 'qualificado';
    db.prepare(`UPDATE leads SET
      nome=COALESCE(?,nome), email=COALESCE(?,email), cidade=COALESCE(?,cidade), objetivo=COALESCE(?,objetivo),
      faixa_investimento=COALESCE(?,faixa_investimento), prazo=COALESCE(?,prazo),
      empreendimento_interesse=COALESCE(?,empreendimento_interesse),
      tipo=COALESCE(?,tipo), score=COALESCE(?,score), resumo=COALESCE(?,resumo),
      status=?, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`)
      .run(nome||null, email||null, cidade||null, objetivo||null, faixa_investimento||null, prazo||null,
           empreendimento_interesse||null, tipo||null, score||null, resumo||null,
           novoStatus, existente.id);
    return ok(res, { id: existente.id, atualizado: true });
  }
  const r = db.prepare(`INSERT INTO leads
    (nome,email,telefone,cidade,objetivo,faixa_investimento,prazo,empreendimento_interesse,tipo,score,resumo,status,origem)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'novo','whatsapp')`)
    .run(nome, email||null, telefone, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, tipo||null, score||0, resumo||null);
  ok(res, { id: r.lastInsertRowid, criado: true });
});

// ─── VENDAS ───────────────────────────────────────────────────────────────────

app.get("/api/vendas", (req, res) => {
  let sql = `
    SELECT v.*, l.nome as lead_nome, l.telefone as lead_telefone,
           c.nome as corretor_nome, e.nome as empreendimento_nome,
           cl.razao_social as cliente_nome,
           vg.numero as vaga_numero, vg.bloco as vaga_bloco, vg.tipo as vaga_tipo
    FROM vendas v
    LEFT JOIN leads l ON l.id = v.lead_id
    LEFT JOIN corretores c ON c.id = v.corretor_id
    LEFT JOIN empreendimentos e ON e.id = v.empreendimento_id
    LEFT JOIN clientes cl ON cl.id = v.cliente_id
    LEFT JOIN vagas_garagem vg ON vg.id = v.vaga_id
    WHERE 1=1
  `;
  const params = [];
  // Corretor só vê as próprias vendas
  if (req.usuario?.perfil === 'corretor' && req.usuario?.corretor_id) {
    sql += " AND v.corretor_id=?"; params.push(req.usuario.corretor_id);
  }
  sql += " ORDER BY v.data_venda DESC";
  ok(res, db.prepare(sql).all(...params));
});

// ─── PAINEL DO CORRETOR ───────────────────────────────────────────────────────

function guardaCorretor(req, res) {
  const id = req.usuario?.corretor_id;
  if (!id) { err(res, 'Usuário não vinculado a um corretor'); return null; }
  return id;
}

app.get("/api/corretor/painel", (req, res) => {
  const corretorId = guardaCorretor(req, res); if (!corretorId) return;
  const corretor   = db.prepare('SELECT * FROM corretores WHERE id=?').get(corretorId);

  // Vendas R2X
  const vendasR2X = db.prepare(`
    SELECT v.*, e.nome as empreendimento_nome, l.nome as lead_nome, l.telefone as lead_tel
    FROM vendas v
    LEFT JOIN empreendimentos e ON e.id = v.empreendimento_id
    LEFT JOIN leads l ON l.id = v.lead_id
    WHERE v.corretor_id=? AND v.status='ativo'
    ORDER BY v.data_venda DESC
  `).all(corretorId);

  // Vendas próprias (externas)
  const vendasProprias = db.prepare(
    `SELECT * FROM corretor_vendas_proprias WHERE corretor_id=? ORDER BY data_venda DESC`
  ).all(corretorId);

  // KPIs R2X
  const r2xTotalVendido = vendasR2X.reduce((s,v)=>s+(v.valor||0),0);
  const r2xComPend      = vendasR2X.filter(v=>v.comissao_corretor_status==='pendente').reduce((s,v)=>s+(v.comissao_corretor_valor||0),0);
  const r2xComPaga      = vendasR2X.filter(v=>v.comissao_corretor_status==='pago').reduce((s,v)=>s+(v.comissao_corretor_valor||0),0);

  // KPIs próprios
  const propTotalVendido = vendasProprias.reduce((s,v)=>s+(v.valor_venda||0),0);
  const propComPend      = vendasProprias.filter(v=>v.status_comissao!=='recebido').reduce((s,v)=>s+Math.max(0,(v.comissao_valor||0)-(v.valor_recebido||0)),0);
  const propComPaga      = vendasProprias.reduce((s,v)=>s+(v.valor_recebido||0),0);

  // Meta do mês atual
  const agora = new Date();
  const mesAtual = agora.getMonth() + 1;
  const anoAtual = agora.getFullYear();
  const meta = db.prepare(`SELECT * FROM corretor_metas_mensais WHERE corretor_id=? AND mes=? AND ano=?`)
    .get(corretorId, mesAtual, anoAtual) || { meta_vgv: 0, meta_qtd: 0, meta_comissao: 0 };

  // Clientes (para aniversariantes)
  const clientes = db.prepare(`SELECT * FROM corretor_clientes WHERE corretor_id=? ORDER BY nome ASC`).all(corretorId);

  // Tarefas de hoje e atrasadas
  const hoje = agora.toISOString().split('T')[0];
  const tarefasHoje      = db.prepare(`SELECT * FROM corretor_tarefas WHERE corretor_id=? AND data_tarefa=? AND concluida=0 ORDER BY hora ASC`).all(corretorId, hoje);
  const tarefasAtrasadas = db.prepare(`SELECT * FROM corretor_tarefas WHERE corretor_id=? AND data_tarefa<? AND concluida=0 ORDER BY data_tarefa ASC`).all(corretorId, hoje);

  ok(res, {
    corretor,
    vendasR2X, r2xTotalVendido, r2xComPend, r2xComPaga,
    vendasProprias, propTotalVendido, propComPend, propComPaga,
    // combinados
    totalVendido : r2xTotalVendido + propTotalVendido,
    comPendente  : r2xComPend + propComPend,
    comPaga      : r2xComPaga + propComPaga,
    qtdVendas    : vendasR2X.length + vendasProprias.length,
    // extras
    meta, clientes, tarefasHoje, tarefasAtrasadas,
  });
});

// CRUD — Vendas próprias do corretor
app.get("/api/corretor/vendas-proprias", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  ok(res, db.prepare(`SELECT * FROM corretor_vendas_proprias WHERE corretor_id=? ORDER BY data_venda DESC`).all(cid));
});

app.post("/api/corretor/vendas-proprias", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { data_venda, empreendimento, imovel, cliente_nome, valor_venda, comissao_pct, comissao_valor, status_comissao, valor_recebido, observacoes } = req.body;
  if (!data_venda || !valor_venda) return err(res, 'Data e valor são obrigatórios');
  const r = db.prepare(`
    INSERT INTO corretor_vendas_proprias
      (corretor_id, data_venda, empreendimento, imovel, cliente_nome, valor_venda, comissao_pct, comissao_valor, status_comissao, valor_recebido, observacoes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(cid, data_venda, empreendimento||null, imovel||null, cliente_nome||null,
         parseFloat(valor_venda)||0, parseFloat(comissao_pct)||null,
         parseFloat(comissao_valor)||null, status_comissao||'pendente',
         parseFloat(valor_recebido)||0, observacoes||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/corretor/vendas-proprias/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM corretor_vendas_proprias WHERE id=? AND corretor_id=?').get(id, cid);
  if (!row) return err(res, 'Não encontrado', 404);
  const { data_venda, empreendimento, imovel, cliente_nome, valor_venda, comissao_pct, comissao_valor, status_comissao, valor_recebido, observacoes } = req.body;
  db.prepare(`
    UPDATE corretor_vendas_proprias
    SET data_venda=?, empreendimento=?, imovel=?, cliente_nome=?, valor_venda=?,
        comissao_pct=?, comissao_valor=?, status_comissao=?, valor_recebido=?, observacoes=?
    WHERE id=? AND corretor_id=?
  `).run(data_venda||row.data_venda, empreendimento??row.empreendimento,
         imovel??row.imovel, cliente_nome??row.cliente_nome,
         parseFloat(valor_venda)||row.valor_venda, parseFloat(comissao_pct)||row.comissao_pct,
         parseFloat(comissao_valor)||row.comissao_valor, status_comissao||row.status_comissao,
         parseFloat(valor_recebido)??row.valor_recebido, observacoes??row.observacoes,
         id, cid);
  ok(res, {});
});

app.delete("/api/corretor/vendas-proprias/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  db.prepare('DELETE FROM corretor_vendas_proprias WHERE id=? AND corretor_id=?').run(parseInt(req.params.id), cid);
  ok(res, {});
});

// ─── CORRETOR: CONFIGURAÇÃO FINANCEIRA ───────────────────────────────────────
app.get("/api/corretor/config", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const row = db.prepare('SELECT * FROM corretor_config WHERE corretor_id=?').get(cid);
  ok(res, row || { imobiliaria_nome: null, imobiliaria_split_pct: 0 });
});

app.put("/api/corretor/config", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { imobiliaria_nome, imobiliaria_split_pct } = req.body;
  db.prepare(`
    INSERT INTO corretor_config (corretor_id, imobiliaria_nome, imobiliaria_split_pct)
    VALUES (?,?,?)
    ON CONFLICT(corretor_id) DO UPDATE SET imobiliaria_nome=excluded.imobiliaria_nome, imobiliaria_split_pct=excluded.imobiliaria_split_pct
  `).run(cid, imobiliaria_nome||null, parseFloat(imobiliaria_split_pct)||0);
  ok(res, {});
});

// ─── CORRETOR: DESPESAS ───────────────────────────────────────────────────────
app.get("/api/corretor/despesas", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  ok(res, db.prepare(`SELECT * FROM corretor_despesas WHERE corretor_id=? ORDER BY recorrente DESC, data_pagamento DESC`).all(cid));
});

app.post("/api/corretor/despesas", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { descricao, categoria, valor, data_pagamento, recorrente, status, observacoes } = req.body;
  if (!descricao || !valor) return err(res, 'Descrição e valor obrigatórios');
  const r = db.prepare(`
    INSERT INTO corretor_despesas (corretor_id, descricao, categoria, valor, data_pagamento, recorrente, status, observacoes)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(cid, descricao, categoria||'outros', parseFloat(valor), data_pagamento||null, recorrente?1:0, status||'pago', observacoes||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/corretor/despesas/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM corretor_despesas WHERE id=? AND corretor_id=?').get(id, cid);
  if (!row) return err(res, 'Não encontrado');
  const { descricao, categoria, valor, data_pagamento, recorrente, status, observacoes } = req.body;
  db.prepare(`
    UPDATE corretor_despesas SET descricao=?, categoria=?, valor=?, data_pagamento=?, recorrente=?, status=?, observacoes=?
    WHERE id=? AND corretor_id=?
  `).run(descricao||row.descricao, categoria||row.categoria, parseFloat(valor)||row.valor,
         data_pagamento||null, recorrente!==undefined?parseInt(recorrente):row.recorrente,
         status||row.status, observacoes||null, id, cid);
  ok(res, {});
});

app.delete("/api/corretor/despesas/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  db.prepare('DELETE FROM corretor_despesas WHERE id=? AND corretor_id=?').run(parseInt(req.params.id), cid);
  ok(res, {});
});

// ─── CORRETOR: FLUXO DE CAIXA PROJETADO ──────────────────────────────────────
app.get("/api/corretor/fluxo", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;

  const config    = db.prepare('SELECT * FROM corretor_config WHERE corretor_id=?').get(cid) || {};
  const splitPct  = config.imobiliaria_split_pct || 0;
  const despesas  = db.prepare('SELECT * FROM corretor_despesas WHERE corretor_id=?').all(cid);

  // Comissões pendentes R2X
  const comR2X = db.prepare(`
    SELECT comissao_corretor_valor, data_venda FROM vendas
    WHERE corretor_id=? AND status='ativo' AND comissao_corretor_status='pendente' AND comissao_corretor_valor > 0
  `).all(cid);

  // Comissões pendentes vendas próprias
  const comProp = db.prepare(`
    SELECT comissao_valor, valor_recebido, data_venda FROM corretor_vendas_proprias
    WHERE corretor_id=? AND status_comissao != 'recebido' AND comissao_valor > 0
  `).all(cid);

  const hoje = new Date();
  const meses = [];

  for (let i = 0; i < 6; i++) {
    const d    = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    const mes  = d.getMonth() + 1;
    const ano  = d.getFullYear();
    const msStr = `${ano}-${String(mes).padStart(2,'0')}`;

    // Despesas recorrentes (todo mês)
    const recorrentes = despesas.filter(x => x.recorrente).reduce((s,x) => s + x.valor, 0);

    // Despesas avulsas pendentes com data neste mês
    const pontual = despesas
      .filter(x => !x.recorrente && x.status === 'pendente' && (x.data_pagamento||'').startsWith(msStr))
      .reduce((s,x) => s + x.valor, 0);

    // Entradas: comissões pendentes vão para o mês atual apenas (sem data exata conhecida)
    let entR2X = 0, entProp = 0;
    if (i === 0) {
      entR2X  = comR2X.reduce((s,v) => s + (v.comissao_corretor_valor||0), 0);
      entProp = comProp.reduce((s,v) => s + Math.max(0, (v.comissao_valor||0) - (v.valor_recebido||0)), 0);
    }
    const entBruta   = entR2X + entProp;
    const split      = entBruta * splitPct / 100;
    const entLiquida = entBruta - split;
    const saidas     = recorrentes + pontual;

    meses.push({ mes, ano, msStr, entBruta, entLiquida, split, splitPct, entR2X, entProp, recorrentes, pontual, saidas, saldo: entLiquida - saidas });
  }

  // Saldo acumulado
  let acumulado = 0;
  for (const m of meses) { acumulado += m.saldo; m.acumulado = acumulado; }

  ok(res, { meses, config, despesas, splitPct });
});

// ─── CORRETOR: AGENDA DE TAREFAS ─────────────────────────────────────────────
app.get("/api/corretor/tarefas", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { concluida } = req.query;
  let sql = `SELECT * FROM corretor_tarefas WHERE corretor_id=?`;
  const params = [cid];
  if (concluida !== undefined) { sql += ` AND concluida=?`; params.push(parseInt(concluida)); }
  sql += ` ORDER BY concluida ASC, data_tarefa ASC, hora ASC`;
  ok(res, db.prepare(sql).all(...params));
});

app.post("/api/corretor/tarefas", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { titulo, tipo, cliente_nome, data_tarefa, hora, observacoes } = req.body;
  if (!titulo) return err(res, 'Título obrigatório');
  const r = db.prepare(`
    INSERT INTO corretor_tarefas (corretor_id, titulo, tipo, cliente_nome, data_tarefa, hora, observacoes)
    VALUES (?,?,?,?,?,?,?)
  `).run(cid, titulo, tipo||'ligacao', cliente_nome||null, data_tarefa||null, hora||null, observacoes||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/corretor/tarefas/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM corretor_tarefas WHERE id=? AND corretor_id=?').get(id, cid);
  if (!row) return err(res, 'Não encontrado');
  const { titulo, tipo, cliente_nome, data_tarefa, hora, concluida, observacoes } = req.body;
  db.prepare(`
    UPDATE corretor_tarefas SET titulo=?, tipo=?, cliente_nome=?, data_tarefa=?, hora=?, concluida=?, observacoes=?
    WHERE id=? AND corretor_id=?
  `).run(titulo??row.titulo, tipo??row.tipo, cliente_nome??null, data_tarefa??null, hora??null,
         concluida!==undefined?parseInt(concluida):row.concluida, observacoes??null, id, cid);
  ok(res, {});
});

app.delete("/api/corretor/tarefas/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  db.prepare('DELETE FROM corretor_tarefas WHERE id=? AND corretor_id=?').run(parseInt(req.params.id), cid);
  ok(res, {});
});

// ─── CORRETOR: META MENSAL ────────────────────────────────────────────────────
app.get("/api/corretor/meta", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);
  const ano = parseInt(req.query.ano) || new Date().getFullYear();
  const row = db.prepare(`SELECT * FROM corretor_metas_mensais WHERE corretor_id=? AND mes=? AND ano=?`).get(cid, mes, ano);
  ok(res, row || { meta_vgv: 0, meta_qtd: 0, meta_comissao: 0, mes, ano });
});

app.post("/api/corretor/meta", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { mes, ano, meta_vgv, meta_qtd, meta_comissao } = req.body;
  db.prepare(`
    INSERT INTO corretor_metas_mensais (corretor_id, mes, ano, meta_vgv, meta_qtd, meta_comissao)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(corretor_id, mes, ano) DO UPDATE SET meta_vgv=excluded.meta_vgv, meta_qtd=excluded.meta_qtd, meta_comissao=excluded.meta_comissao
  `).run(cid, mes, ano, meta_vgv||0, meta_qtd||0, meta_comissao||0);
  ok(res, {});
});

// ─── CORRETOR: CLIENTES PRÓPRIOS ──────────────────────────────────────────────
app.get("/api/corretor/clientes", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  ok(res, db.prepare(`SELECT * FROM corretor_clientes WHERE corretor_id=? ORDER BY nome ASC`).all(cid));
});

app.post("/api/corretor/clientes", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const { nome, cpf, telefone, email, cidade, estado, aniversario, observacoes } = req.body;
  if (!nome) return err(res, 'Nome obrigatório');
  const r = db.prepare(`
    INSERT INTO corretor_clientes (corretor_id, nome, cpf, telefone, email, cidade, estado, aniversario, observacoes)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(cid, nome, cpf||null, telefone||null, email||null, cidade||null, estado||null, aniversario||null, observacoes||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/corretor/clientes/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  const id = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM corretor_clientes WHERE id=? AND corretor_id=?').get(id, cid);
  if (!row) return err(res, 'Não encontrado');
  const { nome, cpf, telefone, email, cidade, estado, aniversario, observacoes } = req.body;
  db.prepare(`
    UPDATE corretor_clientes SET nome=?, cpf=?, telefone=?, email=?, cidade=?, estado=?, aniversario=?, observacoes=?
    WHERE id=? AND corretor_id=?
  `).run(nome||row.nome, cpf||null, telefone||null, email||null, cidade||null, estado||null, aniversario||null, observacoes||null, id, cid);
  ok(res, {});
});

app.delete("/api/corretor/clientes/:id", (req, res) => {
  const cid = guardaCorretor(req, res); if (!cid) return;
  db.prepare('DELETE FROM corretor_clientes WHERE id=? AND corretor_id=?').run(parseInt(req.params.id), cid);
  ok(res, {});
});

// Helper: gera/atualiza entradas financeiras de comissão de uma venda
function sincronizarComissaoVenda(vendaId) {
  const v = db.prepare("SELECT * FROM vendas WHERE id=?").get(vendaId);
  if (!v) return null;

  // Remove entradas antigas vinculadas
  db.prepare("DELETE FROM financeiro_entradas WHERE venda_id=? AND tipo='comissao_venda'").run(vendaId);

  if (v.status === 'distrato' || !v.empreendimento_id) return null;
  const emp = db.prepare("SELECT percentual_r2x, nome FROM empreendimentos WHERE id=?").get(v.empreendimento_id);

  // Usa override da venda se informado, senão usa % padrão do empreendimento
  const pctUsado = v.percentual_r2x_override ?? emp?.percentual_r2x;
  if (!pctUsado) return null;

  const comissao = parseFloat(((v.valor * pctUsado) / 100).toFixed(2));
  const imovelDesc = v.imovel ? ` — ${v.imovel}` : '';
  const overrideLabel = v.percentual_r2x_override ? ` (negociado)` : '';
  const descBase = `Comissão R2X ${pctUsado}%${overrideLabel} — ${emp.nome}${imovelDesc}`;

  // Tenta ler parcelas de entrada (JSON: [{data, valor}, ...])
  let parcelas = null;
  try { parcelas = v.entrada_parcelas ? JSON.parse(v.entrada_parcelas) : null; } catch(_) {}

  if (parcelas && parcelas.length > 0) {
    // Comissão parcelada — uma entrada financeira por parcela de entrada
    const totalEntrada = parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const n = parcelas.length;
    let somaAlocada = 0;
    parcelas.forEach((p, i) => {
      const isUltima = i === n - 1;
      const pesoValor = totalEntrada > 0 ? (Number(p.valor) / totalEntrada) : (1 / n);
      // Última parcela leva o restante para evitar diferença de arredondamento
      const valorParcela = isUltima
        ? parseFloat((comissao - somaAlocada).toFixed(2))
        : parseFloat((comissao * pesoValor).toFixed(2));
      somaAlocada += valorParcela;
      const desc = n > 1 ? `${descBase} (${i+1}/${n})` : descBase;
      db.prepare(`INSERT INTO financeiro_entradas
        (empreendimento_id,venda_id,descricao,tipo,valor,data_prevista,status,parcela_num,parcela_total)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(v.empreendimento_id, vendaId, desc, 'comissao_venda',
             valorParcela, p.data || v.data_venda, 'pendente',
             n > 1 ? i+1 : null, n > 1 ? n : null);
    });
  } else {
    // Sem parcelas de entrada — entrada única na data da venda
    db.prepare(`INSERT INTO financeiro_entradas
      (empreendimento_id,venda_id,descricao,tipo,valor,data_prevista,status)
      VALUES (?,?,?,?,?,?,?)`)
      .run(v.empreendimento_id, vendaId, descBase, 'comissao_venda', comissao, v.data_venda, 'pendente');
  }

  // Atualiza valores calculados na venda (salva o % efetivamente usado)
  db.prepare("UPDATE vendas SET percentual_r2x=?, comissao_r2x=? WHERE id=?").run(pctUsado, comissao, vendaId);
  return comissao;
}

app.post("/api/vendas", (req, res) => {
  const { lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id, vaga_id, valor, data_venda, observacoes, comissao_corretor_pct, comissao_corretor_valor, comissao_corretor_status, valor_entrada, entrada_parcelas, percentual_r2x_override } = req.body;
  if (!valor || !data_venda) return err(res, "Valor e data obrigatórios");

  // Serializa parcelas de entrada como JSON
  const parcelasJson = entrada_parcelas && Array.isArray(entrada_parcelas) && entrada_parcelas.length > 0
    ? JSON.stringify(entrada_parcelas) : null;

  const r = db.prepare(`INSERT INTO vendas
    (lead_id,empreendimento_id,corretor_id,cliente_id,imovel,unidade_id,vaga_id,valor,data_venda,observacoes,status,
     comissao_corretor_pct,comissao_corretor_valor,comissao_corretor_status,valor_entrada,entrada_parcelas,percentual_r2x_override)
    VALUES (?,?,?,?,?,?,?,?,?,?,'ativo',?,?,?,?,?,?)`)
    .run(lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id || null, vaga_id || null,
         valor, data_venda, observacoes,
         comissao_corretor_pct||null, comissao_corretor_valor||null, comissao_corretor_status||'pendente',
         valor_entrada||null, parcelasJson, percentual_r2x_override||null);

  const vendaId = r.lastInsertRowid;
  if (lead_id) db.prepare("UPDATE leads SET status='vendido' WHERE id=?").run(lead_id);
  if (unidade_id) db.prepare("UPDATE unidades SET status='vendido' WHERE id=?").run(unidade_id);
  if (vaga_id) db.prepare("UPDATE vagas_garagem SET status='vendida', venda_id=? WHERE id=?").run(vendaId, vaga_id);

  const comissao = sincronizarComissaoVenda(vendaId);
  const aviso = (empreendimento_id && !comissao) ? 'Atenção: empreendimento sem % R2X cadastrado. Comissão não foi gerada.' : null;

  ok(res, { id: vendaId, comissao_r2x: comissao, aviso });
});

app.put("/api/vendas/:id", (req, res) => {
  const { lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id, vaga_id, valor, data_venda, status, observacoes, comissao_corretor_pct, comissao_corretor_valor, comissao_corretor_status, valor_entrada, entrada_parcelas, percentual_r2x_override } = req.body;
  const vendaAntiga = db.prepare("SELECT unidade_id, vaga_id, status FROM vendas WHERE id=?").get(req.params.id);

  // Serializa parcelas de entrada como JSON
  const parcelasJson = entrada_parcelas && Array.isArray(entrada_parcelas) && entrada_parcelas.length > 0
    ? JSON.stringify(entrada_parcelas) : null;

  db.prepare(`UPDATE vendas SET
    lead_id=?,empreendimento_id=?,corretor_id=?,cliente_id=?,imovel=?,unidade_id=?,vaga_id=?,valor=?,data_venda=?,
    status=?,observacoes=?,comissao_corretor_pct=?,comissao_corretor_valor=?,comissao_corretor_status=?,
    valor_entrada=?,entrada_parcelas=?,percentual_r2x_override=?
    WHERE id=?`)
    .run(lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id || null, vaga_id || null,
         valor, data_venda, status, observacoes,
         comissao_corretor_pct||null, comissao_corretor_valor||null, comissao_corretor_status||'pendente',
         valor_entrada||null, parcelasJson, percentual_r2x_override||null,
         req.params.id);

  // Se mudou unidade, libera a anterior e marca a nova
  if (vendaAntiga?.unidade_id && vendaAntiga.unidade_id != unidade_id) {
    db.prepare("UPDATE unidades SET status='disponivel' WHERE id=?").run(vendaAntiga.unidade_id);
  }
  if (unidade_id) db.prepare("UPDATE unidades SET status=? WHERE id=?").run(status === 'distrato' ? 'disponivel' : 'vendido', unidade_id);

  // Gerencia vaga: libera a anterior se trocou, marca a nova
  if (vendaAntiga?.vaga_id && vendaAntiga.vaga_id != vaga_id) {
    db.prepare("UPDATE vagas_garagem SET status='disponivel', venda_id=NULL WHERE id=?").run(vendaAntiga.vaga_id);
  }
  if (vaga_id) {
    const vagaStatus = status === 'distrato' ? 'disponivel' : 'vendida';
    const vagaVendaId = status === 'distrato' ? null : req.params.id;
    db.prepare("UPDATE vagas_garagem SET status=?, venda_id=? WHERE id=?").run(vagaStatus, vagaVendaId, vaga_id);
  }

  // Recalcula comissão (cria, atualiza ou remove dependendo do estado)
  const comissao = sincronizarComissaoVenda(req.params.id);
  ok(res, { comissao_r2x: comissao });
});

app.delete("/api/vendas/:id", (req, res) => {
  const v = db.prepare("SELECT unidade_id, vaga_id FROM vendas WHERE id=?").get(req.params.id);
  // Remove entradas financeiras vinculadas
  db.prepare("DELETE FROM financeiro_entradas WHERE venda_id=?").run(req.params.id);
  // Libera unidade e vaga
  if (v?.unidade_id) db.prepare("UPDATE unidades SET status='disponivel' WHERE id=?").run(v.unidade_id);
  if (v?.vaga_id) db.prepare("UPDATE vagas_garagem SET status='disponivel', venda_id=NULL WHERE id=?").run(v.vaga_id);
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
  const { empreendimento_id, venda_id, descricao, tipo, valor, data_prevista, data_recebimento, status, observacoes, parcela_num, parcela_total, tem_nf_propria, nf_numero, nf_data } = req.body;
  if (!descricao || !valor) return err(res, "Descrição e valor obrigatórios");
  const nfFlag = tem_nf_propria === false || tem_nf_propria === 0 || tem_nf_propria === '0' ? 0 : 1;
  const r = db.prepare(`INSERT INTO financeiro_entradas (empreendimento_id,venda_id,descricao,tipo,valor,data_prevista,data_recebimento,status,observacoes,parcela_num,parcela_total,tem_nf_propria,nf_numero,nf_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(empreendimento_id, venda_id, descricao, tipo, valor, data_prevista, data_recebimento, status || 'pendente', observacoes, parcela_num||null, parcela_total||null, nfFlag, nf_numero||null, nf_data||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/financeiro/entradas/:id", (req, res) => {
  const { empreendimento_id, descricao, tipo, valor, data_prevista, data_recebimento, status, observacoes, parcela_num, parcela_total, tem_nf_propria, nf_numero, nf_data } = req.body;
  const nfFlag = tem_nf_propria === false || tem_nf_propria === 0 || tem_nf_propria === '0' ? 0 : 1;
  db.prepare(`UPDATE financeiro_entradas SET empreendimento_id=?,descricao=?,tipo=?,valor=?,data_prevista=?,data_recebimento=?,status=?,observacoes=?,parcela_num=?,parcela_total=?,tem_nf_propria=?,nf_numero=?,nf_data=? WHERE id=?`).run(empreendimento_id, descricao, tipo, valor, data_prevista, data_recebimento, status, observacoes, parcela_num||null, parcela_total||null, nfFlag, nf_numero||null, nf_data||null, req.params.id);
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

// ─── IMPORTAÇÃO DE FATURA DE CARTÃO ──────────────────────────────────────────

const uploadFatura = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.post('/api/financeiro/extrair-fatura', uploadFatura.single('fatura'), async (req, res) => {
  if (!req.file) return err(res, 'Arquivo não enviado');
  if (!openai) return err(res, 'Chave OpenAI não configurada no servidor');

  try {
    let texto = '';
    const mime = req.file.mimetype;
    const nome = req.file.originalname.toLowerCase();

    if (mime === 'application/pdf' || nome.endsWith('.pdf')) {
      const parsed = await pdfParse(req.file.buffer);
      texto = parsed.text;
    } else if (nome.endsWith('.docx') || mime.includes('wordprocessingml')) {
      texto = await extrairTextoDocx(req.file.buffer);
    } else {
      return err(res, 'Formato não suportado. Envie PDF ou DOCX.');
    }

    if (!texto || texto.length < 30) return err(res, 'Não foi possível extrair texto do arquivo');

    const textoLimitado = texto.slice(0, 15000);

    const prompt = `Você é um assistente especializado em extrair lançamentos de faturas de cartão de crédito brasileiras.
Leia a fatura abaixo e extraia TODOS os lançamentos (compras, créditos, tarifas, etc).

Retorne APENAS um objeto JSON válido com este formato:
{
  "vencimento": "YYYY-MM-DD ou null",
  "mes_referencia": "YYYY-MM (mês de referência/fechamento desta fatura, ex: 2026-04)",
  "total": número sem formatação ou null,
  "lancamentos": [
    {
      "data": "YYYY-MM-DD",
      "descricao": "descrição exatamente como aparece na fatura",
      "descricao_base": "nome do estabelecimento SEM a parte de parcela (ex: se 'AMAZON 03/12', retorne 'AMAZON')",
      "valor": número positivo (ex: 150.00),
      "tipo": "debito" ou "credito",
      "parcela_atual": número inteiro ou null (ex: 3 se for a 3ª parcela),
      "total_parcelas": número inteiro ou null (ex: 12 se for de 12 parcelas)
    }
  ]
}

Regras:
- Inclua TODOS os lançamentos, inclusive tarifas, IOF, juros, pagamentos e créditos
- Para créditos/estornos, use tipo "credito" e valor positivo
- Para compras/débitos, use tipo "debito" e valor positivo
- Se a data aparecer apenas como dia/mês, use o ano do vencimento ou o ano atual
- Detecte parcelas: padrões como "LOJA 03/12", "LOJA PARC 3/12", "LOJA 3 DE 12" indicam parcela 3 de 12
- Para lançamentos parcelados, preencha parcela_atual e total_parcelas; caso contrário deixe null
- descricao_base: remova apenas a parte numérica de parcela (03/12), mantenha o restante do nome
- Não invente lançamentos — extraia somente o que estiver explicitamente na fatura

FATURA:
${textoLimitado}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const resposta = completion.choices[0].message.content.trim();
    const jsonMatch = resposta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return err(res, 'IA não retornou dados estruturados');

    const dados = JSON.parse(jsonMatch[0]);
    ok(res, dados);
  } catch(e) {
    console.error('[extrair-fatura]', e.message);
    err(res, 'Erro ao processar fatura: ' + e.message);
  }
});

// Importação em lote de lançamentos classificados
app.post('/api/financeiro/importar-fatura', (req, res) => {
  const { lancamentos } = req.body;
  if (!Array.isArray(lancamentos) || lancamentos.length === 0) return err(res, 'Nenhum lançamento enviado');

  const stmt = db.prepare(`INSERT INTO financeiro_saidas
    (empreendimento_id, descricao, categoria, valor, data_pagamento, status, observacoes)
    VALUES (?,?,?,?,?,?,?)`);

  let importados = 0;
  for (const l of lancamentos) {
    if (!l.incluir) continue;
    stmt.run(
      l.empreendimento_id || null,
      l.descricao,
      l.categoria || 'outro',
      Math.abs(parseFloat(l.valor) || 0),
      l.data || null,
      'pago',
      l.observacoes || null
    );
    importados++;
  }
  ok(res, { importados });
});

// ─── PARCELAS DO CARTÃO ────────────────────────────────────────────────────────

// Salvar/atualizar parcelas detectadas numa fatura (deduplicação automática)
app.post('/api/financeiro/salvar-parcelas', (req, res) => {
  const { parcelas, fatura_mes } = req.body;
  if (!Array.isArray(parcelas) || !parcelas.length) return ok(res, { salvos: 0, atualizados: 0 });

  let salvos = 0, atualizados = 0;

  for (const p of parcelas) {
    if (!p.descricao_base || !p.total_parcelas || !p.parcela_atual || !p.valor_parcela) continue;

    const base = String(p.descricao_base).trim().toUpperCase();
    const total = parseInt(p.total_parcelas);
    const atual = parseInt(p.parcela_atual);
    const valor = Math.abs(parseFloat(p.valor_parcela));
    const mes = fatura_mes || null;

    // Busca por chave: descricao_base + total_parcelas + valor próximo (±5%)
    const existente = db.prepare(`
      SELECT * FROM parcelas_cartao
      WHERE descricao_base=? AND total_parcelas=? AND ativo=1
        AND ABS(valor_parcela - ?) / MAX(valor_parcela, 0.01) < 0.05
      ORDER BY parcela_atual DESC LIMIT 1
    `).get(base, total, valor);

    if (existente) {
      // Só atualiza se a nova parcela for mais recente (maior parcela_atual)
      if (atual > existente.parcela_atual) {
        db.prepare(`
          UPDATE parcelas_cartao SET parcela_atual=?, descricao_original=?, fatura_mes=?,
          atualizado_em=CURRENT_TIMESTAMP WHERE id=?
        `).run(atual, p.descricao_original || base, mes, existente.id);
        atualizados++;
      }
    } else {
      db.prepare(`
        INSERT INTO parcelas_cartao (descricao_base, descricao_original, parcela_atual, total_parcelas, valor_parcela, fatura_mes)
        VALUES (?,?,?,?,?,?)
      `).run(base, p.descricao_original || base, atual, total, valor, mes);
      salvos++;
    }
  }

  ok(res, { salvos, atualizados });
});

// Listar parcelas ativas
app.get('/api/financeiro/parcelas', (req, res) => {
  const rows = db.prepare(`SELECT * FROM parcelas_cartao WHERE ativo=1 ORDER BY fatura_mes DESC, descricao_base`).all();
  ok(res, rows);
});

// Desativar parcela manualmente
app.delete('/api/financeiro/parcelas/:id', (req, res) => {
  db.prepare(`UPDATE parcelas_cartao SET ativo=0, atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
  ok(res, {});
});

// Projeção mensal de parcelas para os próximos N meses
app.get('/api/financeiro/projecao-parcelas', (req, res) => {
  const meses = parseInt(req.query.meses) || 12;
  const parcelas = db.prepare(`SELECT * FROM parcelas_cartao WHERE ativo=1`).all();

  // Meses futuros a partir do mês atual
  const hoje = new Date();
  const projecao = {};
  for (let i = 1; i <= meses; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    projecao[key] = { mes: key, total: 0, itens: [] };
  }

  for (const p of parcelas) {
    const restantes = p.total_parcelas - p.parcela_atual;
    if (restantes <= 0) continue;

    // Mês base: fatura_mes da última importação (próximo mês após essa fatura)
    let baseDate;
    if (p.fatura_mes) {
      const [fy, fm] = p.fatura_mes.split('-').map(Number);
      baseDate = new Date(fy, fm, 1); // mês seguinte ao da fatura
    } else {
      baseDate = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
    }

    for (let k = 1; k <= restantes; k++) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + k, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if (projecao[key]) {
        projecao[key].total += p.valor_parcela;
        projecao[key].itens.push({
          id: p.id,
          descricao: p.descricao_base,
          valor: p.valor_parcela,
          parcela: p.parcela_atual + k,
          total_parcelas: p.total_parcelas,
        });
      }
    }
  }

  ok(res, { meses: Object.values(projecao), parcelas_ativas: parcelas.length });
});

// ─── IMPOSTOS (LUCRO PRESUMIDO) ───────────────────────────────────────────────

app.get('/api/impostos/config', (req, res) => {
  const cfg = db.prepare('SELECT * FROM imposto_config WHERE id=1').get();
  ok(res, cfg || {});
});

app.put('/api/impostos/config', (req, res) => {
  const { iss_pct, pis_pct, cofins_pct, irpj_base_presumida_pct, csll_base_presumida_pct, municipio } = req.body;
  db.prepare(`UPDATE imposto_config SET
    iss_pct=?, pis_pct=?, cofins_pct=?, irpj_base_presumida_pct=?, csll_base_presumida_pct=?, municipio=?
    WHERE id=1`)
    .run(iss_pct||3, pis_pct||0.65, cofins_pct||3, irpj_base_presumida_pct||32, csll_base_presumida_pct||32, municipio||'');
  ok(res, {});
});

app.get('/api/impostos/apuracoes', (req, res) => {
  ok(res, db.prepare('SELECT * FROM imposto_apuracao ORDER BY periodo DESC, tipo ASC').all());
});

// Apura impostos de um mês ou trimestre
app.post('/api/impostos/apurar', (req, res) => {
  const { periodo, incluir } = req.body; // incluir: array de tipos ['pis','cofins','iss'] ou ['irpj','csll']
  if (!periodo) return err(res, 'Período obrigatório');

  const cfg = db.prepare('SELECT * FROM imposto_config WHERE id=1').get();
  if (!cfg) return err(res, 'Configure as alíquotas primeiro');

  // Filtra quais impostos incluir (se não informado, inclui todos)
  const filtro = Array.isArray(incluir) && incluir.length > 0 ? incluir : null;

  // Remove apenas os tipos que serão reapurados (preserva os que não estão no filtro)
  if (filtro) {
    filtro.forEach(tipo => db.prepare("DELETE FROM imposto_apuracao WHERE periodo=? AND tipo=?").run(periodo, tipo));
  } else {
    db.prepare("DELETE FROM imposto_apuracao WHERE periodo=?").run(periodo);
  }

  let receitaBase = 0;
  let meses = [];

  if (periodo.includes('-T')) {
    const [ano, tStr] = periodo.split('-T');
    const t = parseInt(tStr);
    const mesInicio = (t - 1) * 3 + 1;
    for (let m = mesInicio; m < mesInicio + 3; m++) {
      meses.push(`${ano}-${String(m).padStart(2,'0')}`);
    }
  } else {
    meses = [periodo];
  }

  // Soma apenas entradas COM NF própria (tem_nf_propria=1 ou NULL para registros antigos)
  // Entradas de NF de terceiros são excluídas de toda a base tributária
  for (const mes of meses) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(valor),0) as total
      FROM financeiro_entradas
      WHERE status='recebido'
        AND (tem_nf_propria IS NULL OR tem_nf_propria=1)
        AND (substr(data_recebimento,1,7)=? OR substr(data_prevista,1,7)=?)
    `).get(mes, mes);
    receitaBase += row.total;
  }

  // Calcula também o total excluído (NF de terceiros) para info
  let receitaExcluida = 0;
  for (const mes of meses) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(valor),0) as total
      FROM financeiro_entradas
      WHERE status='recebido'
        AND tem_nf_propria=0
        AND (substr(data_recebimento,1,7)=? OR substr(data_prevista,1,7)=?)
    `).get(mes, mes);
    receitaExcluida += row.total;
  }

  let todosImpostos = [];
  const ignorados = [];

  if (!periodo.includes('-T')) {
    const [ano, mes] = periodo.split('-');
    const proxMes   = parseInt(mes) === 12 ? 1 : parseInt(mes) + 1;
    const proxAno   = parseInt(mes) === 12 ? parseInt(ano) + 1 : parseInt(ano);
    const proxStr   = `${proxAno}-${String(proxMes).padStart(2,'0')}`;
    const vencMensal = `${proxStr}-25`;
    const vencISS    = `${proxStr}-15`;

    const candidatos = [
      { tipo:'pis',    aliquota: cfg.pis_pct,    vencimento: vencMensal },
      { tipo:'cofins', aliquota: cfg.cofins_pct, vencimento: vencMensal },
      { tipo:'iss',    aliquota: cfg.iss_pct,    vencimento: vencISS    },
    ];
    candidatos.forEach(c => {
      if (!filtro || filtro.includes(c.tipo)) todosImpostos.push(c);
      else ignorados.push(c.tipo);
    });
  } else {
    const [ano, tStr] = periodo.split('-T');
    const t = parseInt(tStr);
    const mesVencNum = t * 3;
    const mesVenc    = mesVencNum > 12 ? mesVencNum - 12 : mesVencNum;
    const anoVenc    = mesVencNum > 12 ? parseInt(ano) + 1 : parseInt(ano);
    const vencTrim   = `${anoVenc}-${String(mesVenc).padStart(2,'0')}-31`;

    const baseIRPJ = parseFloat((receitaBase * cfg.irpj_base_presumida_pct / 100).toFixed(2));
    const baseCSLL = parseFloat((receitaBase * cfg.csll_base_presumida_pct / 100).toFixed(2));
    const adicional = baseIRPJ > 60000 ? parseFloat(((baseIRPJ - 60000) * 0.10).toFixed(2)) : 0;

    const candidatos = [
      { tipo:'irpj', aliquota: 15, base: baseIRPJ, adicional, vencimento: vencTrim },
      { tipo:'csll', aliquota:  9, base: baseCSLL,             vencimento: vencTrim },
    ];
    candidatos.forEach(c => {
      if (!filtro || filtro.includes(c.tipo)) todosImpostos.push(c);
      else ignorados.push(c.tipo);
    });
  }

  const stmt = db.prepare(`INSERT INTO imposto_apuracao
    (periodo, tipo, receita_base, aliquota, valor, adicional_irpj, vencimento)
    VALUES (?,?,?,?,?,?,?)`);

  const result = [];
  for (const imp of todosImpostos) {
    const base   = imp.base ?? receitaBase;
    const valor  = parseFloat((base * imp.aliquota / 100).toFixed(2));
    const adicional = imp.adicional || 0;
    const r = stmt.run(periodo, imp.tipo, receitaBase, imp.aliquota, valor, adicional, imp.vencimento || null);
    result.push({ id: r.lastInsertRowid, tipo: imp.tipo, valor, adicional, vencimento: imp.vencimento });
  }

  ok(res, { periodo, receita_base: receitaBase, receita_excluida: receitaExcluida, impostos: result, ignorados });
});

// Marca imposto como pago e cria saída financeira
app.post('/api/impostos/apuracoes/:id/pagar', (req, res) => {
  const { data_pagamento } = req.body;
  const apur = db.prepare('SELECT * FROM imposto_apuracao WHERE id=?').get(req.params.id);
  if (!apur) return err(res, 'Apuração não encontrada');

  const nomes = { pis:'PIS', cofins:'COFINS', iss:'ISS', irpj:'IRPJ', csll:'CSLL' };
  const valorTotal = apur.valor + (apur.adicional_irpj || 0);

  const r = db.prepare(`INSERT INTO financeiro_saidas
    (descricao, categoria, valor, data_pagamento, status, observacoes)
    VALUES (?,?,?,?,?,?)`)
    .run(
      `${nomes[apur.tipo] || apur.tipo} — ${apur.periodo}`,
      'imposto',
      valorTotal,
      data_pagamento || new Date().toISOString().slice(0,10),
      'pago',
      `Apuração automática Lucro Presumido — base R$ ${apur.receita_base.toLocaleString('pt-BR')}`
    );

  db.prepare(`UPDATE imposto_apuracao SET status='pago', data_pagamento=?, saida_id=? WHERE id=?`)
    .run(data_pagamento || new Date().toISOString().slice(0,10), r.lastInsertRowid, req.params.id);

  ok(res, { saida_id: r.lastInsertRowid });
});

app.delete('/api/impostos/apuracoes/:id', (req, res) => {
  db.prepare('DELETE FROM imposto_apuracao WHERE id=?').run(req.params.id);
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

// ─── COMISSÕES DE CORRETORES ─────────────────────────────────────────────────

app.get("/api/corretores/comissoes", (req, res) => {
  const rows = db.prepare(`
    SELECT c.id as corretor_id, c.nome, c.telefone, c.imobiliaria,
      v.id as venda_id, v.data_venda, v.valor as valor_venda, v.imovel,
      e.nome as empreendimento,
      v.comissao_corretor_pct, v.comissao_corretor_valor, v.comissao_corretor_status
    FROM vendas v
    JOIN corretores c ON c.id = v.corretor_id
    LEFT JOIN empreendimentos e ON e.id = v.empreendimento_id
    WHERE v.status = 'ativo'
    AND v.corretor_id IS NOT NULL
    AND v.comissao_corretor_pct IS NOT NULL
    ORDER BY c.nome, v.data_venda DESC
  `).all();
  ok(res, rows);
});

app.put("/api/vendas/:id/comissao-corretor", (req, res) => {
  const { status } = req.body;
  if (!['pendente','pago'].includes(status)) return err(res, "Status inválido");
  db.prepare("UPDATE vendas SET comissao_corretor_status=? WHERE id=?").run(status, req.params.id);
  ok(res, {});
});

// ─── METAS DE CORRETORES ─────────────────────────────────────────────────────

app.get("/api/metas", (req, res) => {
  const now = new Date();
  const m = parseInt(req.query.mes) || (now.getMonth() + 1);
  const a = parseInt(req.query.ano) || now.getFullYear();
  const rows = db.prepare(`
    SELECT mt.*, c.nome as corretor_nome, e.nome as empreendimento_nome,
      COALESCE((SELECT COUNT(*) FROM vendas v WHERE v.corretor_id=mt.corretor_id AND v.status='ativo'
        AND CAST(strftime('%m',v.data_venda) AS INTEGER)=mt.mes AND CAST(strftime('%Y',v.data_venda) AS INTEGER)=mt.ano
        AND (mt.empreendimento_id IS NULL OR v.empreendimento_id=mt.empreendimento_id)),0) as vendas_realizadas,
      COALESCE((SELECT SUM(v.valor) FROM vendas v WHERE v.corretor_id=mt.corretor_id AND v.status='ativo'
        AND CAST(strftime('%m',v.data_venda) AS INTEGER)=mt.mes AND CAST(strftime('%Y',v.data_venda) AS INTEGER)=mt.ano
        AND (mt.empreendimento_id IS NULL OR v.empreendimento_id=mt.empreendimento_id)),0) as vgv_realizado
    FROM metas_corretores mt
    JOIN corretores c ON c.id=mt.corretor_id
    LEFT JOIN empreendimentos e ON e.id=mt.empreendimento_id
    WHERE mt.mes=? AND mt.ano=?
    ORDER BY c.nome
  `).all(m, a);
  ok(res, rows);
});

app.post("/api/metas", (req, res) => {
  const { corretor_id, empreendimento_id, mes, ano, meta_qtd, meta_vgv } = req.body;
  if (!corretor_id || !mes || !ano) return err(res, "Corretor, mês e ano obrigatórios");
  const r = db.prepare(`INSERT OR REPLACE INTO metas_corretores (corretor_id,empreendimento_id,mes,ano,meta_qtd,meta_vgv) VALUES (?,?,?,?,?,?)`)
    .run(corretor_id, empreendimento_id||null, mes, ano, meta_qtd||0, meta_vgv||0);
  ok(res, { id: r.lastInsertRowid });
});

app.delete("/api/metas/:id", (req, res) => {
  db.prepare("DELETE FROM metas_corretores WHERE id=?").run(req.params.id);
  ok(res, {});
});

// ─── RANKING IMOBILIÁRIAS ─────────────────────────────────────────────────────

app.get("/api/vendas/ranking/imobiliarias", (req, res) => {
  const rows = db.prepare(`
    SELECT c.imobiliaria,
      COUNT(DISTINCT c.id) as corretores,
      COUNT(v.id) as vendas,
      COALESCE(SUM(v.valor),0) as vgv,
      COUNT(DISTINCT v.empreendimento_id) as empreendimentos
    FROM vendas v
    JOIN corretores c ON c.id=v.corretor_id
    WHERE v.status='ativo'
    AND c.imobiliaria IS NOT NULL AND c.imobiliaria != ''
    GROUP BY c.imobiliaria
    ORDER BY vgv DESC LIMIT 20
  `).all();
  ok(res, rows);
});

// ─── TAXA DE CONVERSÃO ───────────────────────────────────────────────────────

app.get("/api/corretores/conversao", (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.nome, c.imobiliaria,
      COUNT(DISTINCT l.id) as leads_recebidos,
      COUNT(DISTINCT CASE WHEN l.status='vendido' THEN l.id END) as leads_convertidos,
      COUNT(DISTINCT v.id) as total_vendas,
      COALESCE(SUM(v.valor),0) as vgv
    FROM corretores c
    LEFT JOIN leads l ON l.corretor_id=c.id
    LEFT JOIN vendas v ON v.corretor_id=c.id AND v.status='ativo'
    WHERE c.ativo=1
    GROUP BY c.id
    HAVING leads_recebidos > 0 OR total_vendas > 0
    ORDER BY leads_convertidos DESC, vgv DESC
  `).all();
  const result = rows.map(r => ({
    ...r,
    taxa_conversao: r.leads_recebidos > 0 ? parseFloat(((r.leads_convertidos / r.leads_recebidos) * 100).toFixed(1)) : 0
  }));
  ok(res, result);
});

// ─── MAPA DE VENDAS (IMAGEM JPEG/PNG + POSIÇÕES MANUAIS) ─────────────────────

// Migration: posições manuais dos marcadores no mapa
try { db.exec('ALTER TABLE unidades ADD COLUMN mapa_x REAL'); } catch(_) {}
try { db.exec('ALTER TABLE unidades ADD COLUMN mapa_y REAL'); } catch(_) {}

// Migration: campos extras de vagas + vínculo com unidade
try { db.exec('ALTER TABLE vagas_garagem ADD COLUMN box TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE vagas_garagem ADD COLUMN tamanho REAL'); } catch(_) {}
try { db.exec('ALTER TABLE vagas_garagem ADD COLUMN pavimento TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE vagas_garagem ADD COLUMN unidade_id INTEGER REFERENCES unidades(id)'); } catch(_) {}

// Upload JPEG/PNG do mapa de vendas — armazenado como data URL base64
app.post('/api/empreendimentos/:id/mapa', upload.single('arquivo'), (req, res) => {
  const empId = parseInt(req.params.id);
  if (!req.file) return err(res, 'Arquivo não enviado');
  const mime = req.file.mimetype;
  if (!['image/jpeg','image/png','image/jpg'].includes(mime)) {
    return err(res, 'Formato não suportado. Envie apenas JPEG ou PNG.');
  }
  const dataUrl = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
  db.prepare('INSERT INTO mapas(empreendimento_id,svg_data) VALUES(?,?) ON CONFLICT(empreendimento_id) DO UPDATE SET svg_data=excluded.svg_data, criado_em=CURRENT_TIMESTAMP').run(empId, dataUrl);
  ok(res, { mensagem: 'Imagem do mapa salva com sucesso!' });
});

// Retorna imagem + unidades com posições para o frontend renderizar
app.get('/api/empreendimentos/:id/mapa', (req, res) => {
  const empId = parseInt(req.params.id);
  const mapa  = db.prepare('SELECT svg_data FROM mapas WHERE empreendimento_id=?').get(empId);
  if (!mapa) return res.status(404).json({ ok: false, error: 'Nenhum mapa importado para este empreendimento' });
  const units = db.prepare('SELECT id, quadra, lote, status, area_m2, preco, mapa_x, mapa_y FROM unidades WHERE empreendimento_id=?').all(empId);
  ok(res, { imagem: mapa.svg_data, units });
});

// Salva posições dos marcadores (batch) — [{id, x, y}]
app.put('/api/empreendimentos/:id/unidades/posicoes', (req, res) => {
  const posicoes = req.body.posicoes || [];
  const update = db.prepare('UPDATE unidades SET mapa_x=?, mapa_y=? WHERE id=?');
  const batch = db.transaction(() => {
    for (const p of posicoes) update.run(p.x ?? null, p.y ?? null, p.id);
  });
  batch();
  ok(res, { atualizadas: posicoes.length });
});

// Remove mapa e limpa posições
app.delete('/api/empreendimentos/:id/mapa', (req, res) => {
  const empId = parseInt(req.params.id);
  db.prepare('DELETE FROM mapas WHERE empreendimento_id=?').run(empId);
  db.prepare('UPDATE unidades SET mapa_x=NULL, mapa_y=NULL WHERE empreendimento_id=?').run(empId);
  ok(res, {});
});

// ─── IMPORTAÇÃO DE LEADS VIA EXCEL ───────────────────────────────────────────

app.post('/api/leads/importar', upload.single('arquivo'), (req, res) => {
  if (!req.file) return err(res, 'Arquivo não enviado');
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Detecta linha de cabeçalho
    let headerRow = -1;
    for (let i = 0; i < Math.min(aoa.length, 8); i++) {
      const row = (aoa[i] || []).map(norm);
      if (row.some(c => c === 'nome') && row.some(c => c === 'telefone' || c === 'tel')) {
        headerRow = i; break;
      }
    }
    if (headerRow === -1) return err(res, 'Cabeçalho não encontrado. Use colunas: Nome, Telefone, Email, Cidade, Objetivo, Empreendimento, Corretor');

    const headers = aoa[headerRow].map(norm);
    const idx = (...names) => {
      for (const n of names) { const i = headers.indexOf(norm(n)); if (i !== -1) return i; }
      for (const n of names) { const i = headers.findIndex(h => h && h.includes(norm(n))); if (i !== -1) return i; }
      return -1;
    };

    const iNome     = idx('nome');
    const iTel      = idx('telefone','tel','fone','whatsapp','celular');
    const iEmail    = idx('email','e-mail');
    const iCidade   = idx('cidade');
    const iObjetivo = idx('objetivo','interesse');
    const iFaixa    = idx('faixa','investimento','valor','preco');
    const iPrazo    = idx('prazo');
    const iObs      = idx('observacao','observacoes','obs','nota');
    const iStatus   = idx('status');
    const iOrigem   = idx('origem','source','fonte');

    const insert = db.prepare(`INSERT INTO leads (nome,telefone,email,cidade,objetivo,faixa_investimento,prazo,observacoes,status,origem) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let importados = 0, ignorados = 0;

    const importAll = db.transaction(() => {
      for (let i = headerRow + 1; i < aoa.length; i++) {
        const row = aoa[i] || [];
        const nome = iNome >= 0 ? String(row[iNome] || '').trim() : '';
        const tel  = iTel  >= 0 ? String(row[iTel]  || '').replace(/\D/g, '') : '';
        if (!nome && !tel) { ignorados++; continue; }
        // Ignora duplicatas por telefone
        if (tel && db.prepare('SELECT id FROM leads WHERE telefone=?').get(tel)) { ignorados++; continue; }
        const status = iStatus >= 0 && row[iStatus] ? String(row[iStatus]).trim() : 'novo';
        const origem = iOrigem >= 0 && row[iOrigem] ? String(row[iOrigem]).trim() : 'excel';
        insert.run(
          nome || null,
          tel  || (iNome >= 0 ? String(row[iNome] || '').trim() : null),
          iEmail    >= 0 ? String(row[iEmail]    || '').trim() || null : null,
          iCidade   >= 0 ? String(row[iCidade]   || '').trim() || null : null,
          iObjetivo >= 0 ? String(row[iObjetivo] || '').trim() || null : null,
          iFaixa    >= 0 ? String(row[iFaixa]    || '').trim() || null : null,
          iPrazo    >= 0 ? String(row[iPrazo]    || '').trim() || null : null,
          iObs      >= 0 ? String(row[iObs]      || '').trim() || null : null,
          status, origem
        );
        importados++;
      }
    });
    importAll();
    ok(res, { importados, ignorados });
  } catch (e) {
    err(res, 'Erro ao processar arquivo: ' + e.message);
  }
});

// ─── PAINEL DE LANÇAMENTO ─────────────────────────────────────────────────────

app.get('/api/painel/:id', (req, res) => {
  const empId = parseInt(req.params.id);
  const emp = db.prepare('SELECT * FROM empreendimentos WHERE id=?').get(empId);
  if (!emp) return err(res, 'Empreendimento não encontrado', 404);

  const unidadeStats = db.prepare(`
    SELECT status, COUNT(*) as n FROM unidades WHERE empreendimento_id=? GROUP BY status
  `).all(empId);
  const totalUnidades = unidadeStats.reduce((s, u) => s + u.n, 0);
  const vendidas   = unidadeStats.find(u => u.status === 'vendido')?.n   || 0;
  const reservadas = unidadeStats.find(u => u.status === 'reservado')?.n || 0;

  const vgv_total = db.prepare("SELECT COALESCE(SUM(valor),0) as v FROM vendas WHERE empreendimento_id=? AND status='ativo'").get(empId).v;
  const vgv_mes   = db.prepare("SELECT COALESCE(SUM(valor),0) as v FROM vendas WHERE empreendimento_id=? AND status='ativo' AND strftime('%Y-%m',data_venda)=strftime('%Y-%m','now')").get(empId).v;
  const hoje      = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(valor),0) as v FROM vendas WHERE empreendimento_id=? AND status='ativo' AND date(data_venda)=date('now')").get(empId);

  const top_corretores = db.prepare(`
    SELECT c.nome, c.imobiliaria, COUNT(v.id) as vendas, COALESCE(SUM(v.valor),0) as vgv
    FROM vendas v JOIN corretores c ON c.id=v.corretor_id
    WHERE v.empreendimento_id=? AND v.status='ativo'
    GROUP BY c.id ORDER BY vendas DESC LIMIT 10
  `).all(empId);

  const ultimas_vendas = db.prepare(`
    SELECT v.data_venda, v.valor, v.imovel,
           l.nome as lead_nome, c.nome as corretor_nome
    FROM vendas v
    LEFT JOIN leads l ON l.id=v.lead_id
    LEFT JOIN corretores c ON c.id=v.corretor_id
    WHERE v.empreendimento_id=? AND v.status='ativo'
    ORDER BY v.id DESC LIMIT 15
  `).all(empId);

  const vso = totalUnidades > 0 ? parseFloat(((vendidas / totalUnidades) * 100).toFixed(1)) : 0;

  ok(res, {
    empreendimento: emp,
    unidades: { total: totalUnidades, vendidas, reservadas, disponiveis: totalUnidades - vendidas - reservadas },
    vso,
    vgv_total, vgv_mes,
    vendas_hoje: hoje.n, vgv_hoje: hoje.v,
    top_corretores,
    ultimas_vendas,
  });
});

// ─── CHECKLIST DE MARKETING ──────────────────────────────────────────────────

const MATERIAIS_PADRAO = [
  'Naming e Slogan','Identidade Visual (logo, paleta de cores, tipografia)',
  'Mapa de Vendas','Playbook Corretores','Teaser (campanha de pré-lançamento)',
  'Tabela de Preços','Vídeo aéreo (drone)','Fotos da região e entorno',
  'Landing Page','Renders 3D externos','Renders 3D internos (decorados)',
  'Tour Virtual 360°','Vídeo institucional','Apresentação Meeting',
  'Outdoor','Folder impresso','Planta Humanizada','Apresentação comercial (PPT)',
  'Camisetas de uniforme','Catálogo/Book','Memorial Descritivo',
  'Pack para redes sociais (posts e stories)','Criativos para Google Ads',
  'Banners para portais imobiliários','E-mail marketing','Placa de obra/Tapume',
  'Estande de vendas (projeto e ambientação)','Material POP (flyers, cartões, brindes)',
  'Régua de relacionamento (CRM)','Releases para imprensa',
];

// Retorna checklist — cria itens padrão automaticamente se estiver vazio
app.get('/api/empreendimentos/:id/checklist', (req, res) => {
  const empId = parseInt(req.params.id);
  let items = db.prepare('SELECT * FROM checklist_marketing WHERE empreendimento_id=? ORDER BY ordem,id').all(empId);
  if (!items.length) {
    const ins = db.prepare('INSERT INTO checklist_marketing(empreendimento_id,material,ordem) VALUES(?,?,?)');
    const batch = db.transaction(() => MATERIAIS_PADRAO.forEach((m, i) => ins.run(empId, m, i + 1)));
    batch();
    items = db.prepare('SELECT * FROM checklist_marketing WHERE empreendimento_id=? ORDER BY ordem,id').all(empId);
  }
  ok(res, items);
});

// Atualiza item do checklist
app.put('/api/checklist/:id', (req, res) => {
  const { status, responsavel, data_entrega } = req.body;
  db.prepare('UPDATE checklist_marketing SET status=COALESCE(?,status), responsavel=?, data_entrega=? WHERE id=?')
    .run(status ?? null, responsavel ?? null, data_entrega ?? null, parseInt(req.params.id));
  ok(res, {});
});

// Adiciona item personalizado
app.post('/api/empreendimentos/:id/checklist', (req, res) => {
  const empId = parseInt(req.params.id);
  const { material } = req.body;
  if (!material) return err(res, 'Material obrigatório');
  const maxOrdem = db.prepare('SELECT MAX(ordem) as m FROM checklist_marketing WHERE empreendimento_id=?').get(empId)?.m || 0;
  const r = db.prepare('INSERT INTO checklist_marketing(empreendimento_id,material,ordem) VALUES(?,?,?)').run(empId, material, maxOrdem + 1);
  ok(res, { id: r.lastInsertRowid });
});

// Remove item do checklist
app.delete('/api/checklist/:id', (req, res) => {
  db.prepare('DELETE FROM checklist_marketing WHERE id=?').run(parseInt(req.params.id));
  ok(res, {});
});

// ─── PROPOSTA COMERCIAL ───────────────────────────────────────────────────────

app.get('/api/leads/:id/proposta', (req, res) => {
  const lead = db.prepare('SELECT l.*, c.nome as corretor_nome, e.nome as emp_nome, e.cidade as emp_cidade, e.estado as emp_estado, e.num_unidades, e.vgv_estimado, e.percentual_r2x FROM leads l LEFT JOIN corretores c ON c.id=l.corretor_id LEFT JOIN empreendimentos e ON e.id=l.empreendimento_id WHERE l.id=?').get(parseInt(req.params.id));
  if (!lead) return err(res, 'Lead não encontrado', 404);

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Proposta Comercial — ${lead.nome}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #fff; color: #1a1a2e; padding: 40px; max-width: 800px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 24px; border-bottom: 3px solid #00C4B4; margin-bottom: 32px; }
  .logo { font-size: 28px; font-weight: 900; color: #0D1B2E; }
  .logo span { color: #00C4B4; }
  .tag { background: #00C4B4; color: #0D1B2E; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; }
  h1 { font-size: 26px; font-weight: 900; margin-bottom: 6px; }
  .subtitle { color: #64748b; font-size: 14px; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; }
  .card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 6px; }
  .card-value { font-size: 18px; font-weight: 700; color: #0D1B2E; }
  .section-title { font-size: 16px; font-weight: 700; color: #0D1B2E; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #0D1B2E; color: #fff; padding: 10px 14px; text-align: left; font-weight: 600; }
  td { padding: 10px 14px; border-bottom: 1px solid #e2e8f0; }
  tr:hover td { background: #f8fafc; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #94a3b8; font-size: 12px; }
  .accent { color: #00C4B4; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">R2X <span>Comercial</span></div>
    <div class="tag">PROPOSTA COMERCIAL</div>
  </div>
  <h1>Olá, ${lead.nome}!</h1>
  <p class="subtitle">Preparamos esta proposta especialmente para você com base no seu perfil de investimento.</p>
  <div class="grid">
    <div class="card"><div class="card-title">Empreendimento de Interesse</div><div class="card-value">${lead.emp_nome || lead.empreendimento_interesse || '—'}</div></div>
    <div class="card"><div class="card-title">Localização</div><div class="card-value">${[lead.emp_cidade, lead.emp_estado].filter(Boolean).join(' / ') || '—'}</div></div>
    <div class="card"><div class="card-title">Faixa de Investimento</div><div class="card-value accent">${lead.faixa_investimento || '—'}</div></div>
    <div class="card"><div class="card-title">Prazo de Compra</div><div class="card-value">${lead.prazo || '—'}</div></div>
  </div>
  <div class="section-title">Perfil do Cliente</div>
  <table>
    <tr><th>Campo</th><th>Informação</th></tr>
    <tr><td>Nome</td><td><strong>${lead.nome || '—'}</strong></td></tr>
    <tr><td>Contato</td><td>${lead.telefone || '—'}${lead.email ? ' · ' + lead.email : ''}</td></tr>
    <tr><td>Cidade</td><td>${lead.cidade || '—'}</td></tr>
    <tr><td>Objetivo</td><td>${lead.objetivo || '—'}</td></tr>
    <tr><td>Corretor Responsável</td><td>${lead.corretor_nome || '—'}</td></tr>
  </table>
  ${lead.num_unidades ? `
  <div class="section-title">Sobre o Empreendimento</div>
  <table>
    <tr><th>Informação</th><th>Detalhe</th></tr>
    <tr><td>Total de Unidades</td><td>${lead.num_unidades}</td></tr>
    ${lead.vgv_estimado ? `<tr><td>VGV Estimado</td><td>R$ ${Number(lead.vgv_estimado).toLocaleString('pt-BR', {minimumFractionDigits:2})}</td></tr>` : ''}
  </table>` : ''}
  <div class="footer">
    <p><strong>R2X Aceleradora de Vendas</strong> · Braço do Norte, SC</p>
    <p style="margin-top:4px">Proposta gerada em ${new Date().toLocaleDateString('pt-BR')} — Documento confidencial</p>
  </div>
  <script>window.onload=()=>window.print()<\/script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─── RELATÓRIO DE COMISSÕES ───────────────────────────────────────────────────

app.get('/api/relatorios/comissoes', (req, res) => {
  const rows = db.prepare(`
    SELECT c.nome, c.telefone,
      COUNT(v.id) as total_vendas,
      SUM(v.valor) as vgv_total,
      SUM(v.comissao_corretor_valor) as comissao_total,
      SUM(CASE WHEN v.comissao_corretor_status='pago' THEN v.comissao_corretor_valor ELSE 0 END) as comissao_paga,
      SUM(CASE WHEN v.comissao_corretor_status='pendente' THEN v.comissao_corretor_valor ELSE 0 END) as comissao_pendente
    FROM corretores c
    LEFT JOIN vendas v ON v.corretor_id=c.id AND v.status='ativo'
    WHERE c.ativo=1
    GROUP BY c.id ORDER BY comissao_total DESC
  `).all();
  ok(res, rows);
});

// ─── EXPORTAÇÃO EXCEL ─────────────────────────────────────────────────────────

app.get('/api/exportar/leads', (req, res) => {
  const rows = db.prepare(`SELECT l.nome, l.telefone, l.email, l.cidade, l.status, l.origem, l.objetivo, l.faixa_investimento, l.prazo, l.empreendimento_interesse, c.nome as corretor, e.nome as empreendimento, l.criado_em FROM leads l LEFT JOIN corretores c ON c.id=l.corretor_id LEFT JOIN empreendimentos e ON e.id=l.empreendimento_id ORDER BY l.criado_em DESC`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
});

app.get('/api/exportar/vendas', (req, res) => {
  const rows = db.prepare(`SELECT v.data_venda, l.nome as lead, e.nome as empreendimento, c.nome as corretor, v.imovel, v.valor, v.comissao_corretor_pct, v.comissao_corretor_valor, v.comissao_corretor_status, v.status, v.observacoes FROM vendas v LEFT JOIN leads l ON l.id=v.lead_id LEFT JOIN empreendimentos e ON e.id=v.empreendimento_id LEFT JOIN corretores c ON c.id=v.corretor_id ORDER BY v.data_venda DESC`).all();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vendas');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="vendas-${new Date().toISOString().slice(0,10)}.xlsx"`);
  res.send(buf);
});

// ─── PORTAL DO INCORPORADOR ───────────────────────────────────────────────────

app.post('/api/empreendimentos/:id/portal/token', (req, res) => {
  const empId = parseInt(req.params.id);
  const token = crypto.randomBytes(16).toString('hex');
  try {
    db.exec("CREATE TABLE IF NOT EXISTS portal_tokens (token TEXT PRIMARY KEY, empreendimento_id INTEGER, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)");
  } catch(_) {}
  db.prepare("INSERT OR REPLACE INTO portal_tokens(token, empreendimento_id) VALUES(?,?)").run(token, empId);
  ok(res, { token, url: `/portal/${token}` });
});

app.get('/api/portal/:token', (req, res) => {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS portal_tokens (token TEXT PRIMARY KEY, empreendimento_id INTEGER, criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)");
  } catch(_) {}
  const pt = db.prepare('SELECT * FROM portal_tokens WHERE token=?').get(req.params.token);
  if (!pt) return err(res, 'Link inválido ou expirado', 404);
  const empId = pt.empreendimento_id;
  const emp = db.prepare('SELECT * FROM empreendimentos WHERE id=?').get(empId);
  if (!emp) return err(res, 'Empreendimento não encontrado', 404);
  const unidadesGrupo = db.prepare('SELECT status, COUNT(*) as n FROM unidades WHERE empreendimento_id=? GROUP BY status').all(empId);
  const vendas = db.prepare(`
    SELECT v.data_venda, v.imovel, v.valor, c.nome as corretor_nome
    FROM vendas v
    LEFT JOIN corretores c ON c.id = v.corretor_id
    WHERE v.empreendimento_id=? AND v.status='ativo'
    ORDER BY v.data_venda DESC
  `).all(empId);
  const checklist = db.prepare('SELECT material, responsavel, status, data_entrega FROM checklist_marketing WHERE empreendimento_id=? ORDER BY ordem').all(empId);
  const totalUnidades = unidadesGrupo.reduce((s, u) => s + u.n, 0);
  const vendidas   = unidadesGrupo.find(u => u.status === 'vendido')?.n   || 0;
  const reservadas = unidadesGrupo.find(u => u.status === 'reservado')?.n || 0;
  const disponiveis= unidadesGrupo.find(u => u.status === 'disponivel')?.n|| 0;
  ok(res, { emp, totalUnidades, vendidas, reservadas, disponiveis, vendas, checklist });
});

// ─── EVENTOS ──────────────────────────────────────────────────────────────────

// Template padrão de checklist de lançamento
const CHECKLIST_TEMPLATE = [
  // Pré-evento — Logística
  { fase:'pre', categoria:'Logística e estrutura', ordem:1,  texto:'Confirmar contrato e reserva do espaço de eventos', sub_texto:'Verificar capacidade, horário de entrada e saída' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:2,  texto:'Contratar buffet para jantar por consumê', sub_texto:'Definir cardápio, número de convidados e serviço de garçons' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:3,  texto:'Definir bebidas — bar e sommelier', sub_texto:'Vinhos, espumante para brinde, drinks e opções sem álcool' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:4,  texto:'Contratar estrutura audiovisual', sub_texto:'Projetor ou LED, sistema de som, microfone e iluminação cênica' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:5,  texto:'Planejar layout do espaço', sub_texto:'Disposição das mesas, palco/púlpito, área de coquetel de entrada' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:6,  texto:'Contratar fotógrafo e/ou videomaker', sub_texto:'Cobertura do evento para uso em marketing pós-evento' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:7,  texto:'Definir decoração com identidade visual do empreendimento', sub_texto:'Totem, backdrop, centros de mesa, sinalização' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:8,  texto:'Produzir material impresso', sub_texto:'Pasta/brochura do empreendimento, tabela de preços, book de plantas' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:9,  texto:'Preparar kit brinde / lembrança para convidados', sub_texto:'Item personalizado com a marca do empreendimento' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:10, texto:'Montar lista de convidados com RSVP', sub_texto:'Corretores parceiros, investidores, imprensa, clientes VIP' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:11, texto:'Credenciar recepcionistas para entrada', sub_texto:'Check-in com crachá/nome na lista e entrega do material' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:12, texto:'Preparar apresentação (slides) do empreendimento', sub_texto:'História, diferenciais, plantas, acabamentos, localização, condições' },
  { fase:'pre', categoria:'Logística e estrutura', ordem:13, texto:'Ensaio/passagem de áudio e apresentação no espaço', sub_texto:'Testar equipamentos e definir ordem da programação' },
  // Pré-evento — Marketing
  { fase:'pre', categoria:'Marketing pré-evento', ordem:14, texto:'Criar identidade visual do evento', sub_texto:'Artes para convite, stories, feed e WhatsApp' },
  { fase:'pre', categoria:'Marketing pré-evento', ordem:15, texto:'Enviar convite formal — e-mail e WhatsApp', sub_texto:'Texto profissional com data, horário, local e RSVP (3 semanas antes)' },
  { fase:'pre', categoria:'Marketing pré-evento', ordem:16, texto:'Publicar teaser nas redes sociais', sub_texto:'"Algo está chegando..." — gerar expectativa sem revelar tudo' },
  { fase:'pre', categoria:'Marketing pré-evento', ordem:17, texto:'Criar contagem regressiva nos stories', sub_texto:'Posts diários na semana do evento' },
  { fase:'pre', categoria:'Marketing pré-evento', ordem:18, texto:'Disparar lembrete 1 semana antes', sub_texto:'WhatsApp individual para corretores confirmados' },
  { fase:'pre', categoria:'Marketing pré-evento', ordem:19, texto:'Disparar lembrete 48h antes', sub_texto:'Confirmar presença + informar endereço e estacionamento' },
  { fase:'pre', categoria:'Marketing pré-evento', ordem:20, texto:'Preparar conteúdo de bastidores para stories no dia', sub_texto:'Montagem do espaço, decoração, equipe — humaniza a marca' },
  // No evento — Recepção
  { fase:'evento', categoria:'Chegada e recepção', ordem:1, texto:'Equipe presente no espaço 2h antes para montagem final', sub_texto:'' },
  { fase:'evento', categoria:'Chegada e recepção', ordem:2, texto:'Check-in funcionando — lista de convidados e crachás prontos', sub_texto:'' },
  { fase:'evento', categoria:'Chegada e recepção', ordem:3, texto:'Coquetel de boas-vindas disponível na chegada', sub_texto:'Espumante, drinks e canapés enquanto aguardam o jantar' },
  { fase:'evento', categoria:'Chegada e recepção', ordem:4, texto:'Música ambiente ativa (playlist preparada)', sub_texto:'' },
  { fase:'evento', categoria:'Chegada e recepção', ordem:5, texto:'Material impresso disponível nas mesas ou na entrada', sub_texto:'' },
  { fase:'evento', categoria:'Chegada e recepção', ordem:6, texto:'Fotógrafo registrando chegada e ambiente', sub_texto:'' },
  // No evento — Programação
  { fase:'evento', categoria:'Programação', ordem:7,  texto:'Abertura e boas-vindas pelo apresentador/diretor', sub_texto:'Agradecimento aos presentes, apresentação da incorporadora' },
  { fase:'evento', categoria:'Programação', ordem:8,  texto:'Apresentação do empreendimento', sub_texto:'Conceito, localização, plantas, acabamentos, condições comerciais' },
  { fase:'evento', categoria:'Programação', ordem:9,  texto:'Jantar por consumê servido durante ou após a apresentação', sub_texto:'' },
  { fase:'evento', categoria:'Programação', ordem:10, texto:'Brinde oficial com espumante', sub_texto:'Momento simbólico de lançamento — ótimo para foto' },
  { fase:'evento', categoria:'Programação', ordem:11, texto:'Espaço para dúvidas e networking', sub_texto:'Corretores com acesso à equipe comercial e materiais' },
  // No evento — Conteúdo
  { fase:'evento', categoria:'Conteúdo em tempo real', ordem:12, texto:'Publicar stories ao vivo do evento', sub_texto:'Ambiente, apresentação, brinde, bastidores' },
  { fase:'evento', categoria:'Conteúdo em tempo real', ordem:13, texto:'Coletar depoimentos rápidos em vídeo no evento', sub_texto:'Corretores e convidados falando sobre o empreendimento' },
  { fase:'evento', categoria:'Conteúdo em tempo real', ordem:14, texto:'Entregar kit brinde / lembrança na saída', sub_texto:'' },
  // Pós-evento — Follow-up
  { fase:'pos', categoria:'Follow-up comercial', ordem:1, texto:'Enviar agradecimento a todos os presentes', sub_texto:'Mensagem personalizada por WhatsApp ou e-mail (até 24h depois)' },
  { fase:'pos', categoria:'Follow-up comercial', ordem:2, texto:'Enviar tabela de preços e book digital para corretores', sub_texto:'PDF ou link de acesso — facilitar o processo de venda' },
  { fase:'pos', categoria:'Follow-up comercial', ordem:3, texto:'Contatar convidados que confirmaram mas não compareceram', sub_texto:'Enviar o material e agendar visita ou reunião individual' },
  { fase:'pos', categoria:'Follow-up comercial', ordem:4, texto:'Agendar reuniões de follow-up com corretores de interesse', sub_texto:'' },
  { fase:'pos', categoria:'Follow-up comercial', ordem:5, texto:'Registrar leads e intenções de compra captados no evento', sub_texto:'' },
  // Pós-evento — Marketing
  { fase:'pos', categoria:'Marketing pós-evento', ordem:6,  texto:'Editar e publicar fotos do evento nas redes sociais', sub_texto:'Feed e stories — gerar prova social e ampliar alcance' },
  { fase:'pos', categoria:'Marketing pós-evento', ordem:7,  texto:'Editar e publicar vídeo/reels do lançamento', sub_texto:'Destaque para o ambiente, apresentação e brinde' },
  { fase:'pos', categoria:'Marketing pós-evento', ordem:8,  texto:'Publicar depoimentos coletados no evento', sub_texto:'Stories, reels e feed — voz dos corretores/convidados' },
  { fase:'pos', categoria:'Marketing pós-evento', ordem:9,  texto:'Disparar e-mail marketing de pós-lançamento', sub_texto:'"Empreendimento lançado. Unidades disponíveis." + CTA para contato' },
  { fase:'pos', categoria:'Marketing pós-evento', ordem:10, texto:'Criar campanha de anúncios pós-evento', sub_texto:'Usar fotos/vídeos reais do lançamento como criativo' },
  { fase:'pos', categoria:'Marketing pós-evento', ordem:11, texto:'Publicar Press Release / nota à imprensa local', sub_texto:'Divulgação nos portais de notícias e grupos do setor' },
  // Pós-evento — Avaliação
  { fase:'pos', categoria:'Avaliação interna', ordem:12, texto:'Reunião de debriefing com a equipe', sub_texto:'O que funcionou, o que melhorar para o próximo lançamento' },
  { fase:'pos', categoria:'Avaliação interna', ordem:13, texto:'Contabilizar leads, propostas e reservas geradas', sub_texto:'' },
  { fase:'pos', categoria:'Avaliação interna', ordem:14, texto:'Enviar pesquisa de satisfação aos corretores presentes', sub_texto:'' },
];

app.get('/api/eventos', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*,
      emp.nome as empreendimento_nome,
      (SELECT COUNT(*) FROM evento_checklist WHERE evento_id=e.id) as total_itens,
      (SELECT COUNT(*) FROM evento_checklist WHERE evento_id=e.id AND concluido=1) as itens_concluidos
    FROM eventos e
    LEFT JOIN empreendimentos emp ON emp.id = e.empreendimento_id
    ORDER BY e.data ASC
  `).all();
  ok(res, rows);
});

app.post('/api/eventos', (req, res) => {
  const { titulo, data, hora, local, empreendimento_id, descricao, usar_template } = req.body;
  if (!titulo || !data) return err(res, 'Título e data obrigatórios');
  const r = db.prepare('INSERT INTO eventos(titulo,data,hora,local,empreendimento_id,descricao) VALUES(?,?,?,?,?,?)')
    .run(titulo, data, hora||null, local||null, empreendimento_id||null, descricao||null);
  const eventoId = r.lastInsertRowid;
  if (usar_template) {
    const ins = db.prepare('INSERT INTO evento_checklist(evento_id,fase,categoria,texto,sub_texto,ordem) VALUES(?,?,?,?,?,?)');
    for (const item of CHECKLIST_TEMPLATE) ins.run(eventoId, item.fase, item.categoria, item.texto, item.sub_texto||null, item.ordem);
  }
  ok(res, { id: eventoId });
});

app.get('/api/eventos/:id', (req, res) => {
  const ev = db.prepare('SELECT e.*, emp.nome as empreendimento_nome FROM eventos e LEFT JOIN empreendimentos emp ON emp.id=e.empreendimento_id WHERE e.id=?').get(parseInt(req.params.id));
  if (!ev) return err(res, 'Evento não encontrado', 404);
  const checklist = db.prepare('SELECT * FROM evento_checklist WHERE evento_id=? ORDER BY fase, ordem').all(ev.id);
  ok(res, { ...ev, checklist });
});

app.put('/api/eventos/:id', (req, res) => {
  const { titulo, data, hora, local, empreendimento_id, descricao } = req.body;
  const id = parseInt(req.params.id);
  const ev = db.prepare('SELECT id FROM eventos WHERE id=?').get(id);
  if (!ev) return err(res, 'Evento não encontrado', 404);
  db.prepare('UPDATE eventos SET titulo=?,data=?,hora=?,local=?,empreendimento_id=?,descricao=? WHERE id=?')
    .run(titulo, data, hora||null, local||null, empreendimento_id||null, descricao||null, id);
  ok(res, {});
});

app.delete('/api/eventos/:id', (req, res) => {
  db.prepare('DELETE FROM eventos WHERE id=?').run(parseInt(req.params.id));
  ok(res, {});
});

app.post('/api/eventos/:id/checklist', (req, res) => {
  const { fase, categoria, texto, sub_texto, ordem } = req.body;
  if (!texto) return err(res, 'Texto obrigatório');
  const maxOrdem = db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM evento_checklist WHERE evento_id=? AND fase=?').get(parseInt(req.params.id), fase||'pre').m;
  const r = db.prepare('INSERT INTO evento_checklist(evento_id,fase,categoria,texto,sub_texto,ordem) VALUES(?,?,?,?,?,?)')
    .run(parseInt(req.params.id), fase||'pre', categoria||null, texto, sub_texto||null, ordem||maxOrdem+1);
  ok(res, { id: r.lastInsertRowid });
});

app.put('/api/evento-checklist/:id', (req, res) => {
  const { concluido, responsavel, observacoes, texto, sub_texto, categoria } = req.body;
  const id = parseInt(req.params.id);
  const item = db.prepare('SELECT * FROM evento_checklist WHERE id=?').get(id);
  if (!item) return err(res, 'Item não encontrado', 404);
  db.prepare('UPDATE evento_checklist SET concluido=?,responsavel=?,observacoes=?,texto=?,sub_texto=?,categoria=? WHERE id=?')
    .run(concluido??item.concluido, responsavel??item.responsavel, observacoes??item.observacoes, texto||item.texto, sub_texto??item.sub_texto, categoria??item.categoria, id);
  ok(res, {});
});

app.delete('/api/evento-checklist/:id', (req, res) => {
  db.prepare('DELETE FROM evento_checklist WHERE id=?').run(parseInt(req.params.id));
  ok(res, {});
});

// ─── INCORPORADOR ─────────────────────────────────────────────────────────────

function guardaIncorporador(req, res) {
  const id = req.usuario?.cliente_id;
  if (!id) { err(res, 'Usuário não vinculado a um incorporador'); return null; }
  return id;
}

app.get('/api/incorporador/painel', (req, res) => {
  const clienteId = guardaIncorporador(req, res);
  if (!clienteId) return;

  const cliente = db.prepare('SELECT * FROM clientes WHERE id=?').get(clienteId);
  if (!cliente) return err(res, 'Incorporador não encontrado', 404);

  const empreendimentos = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM unidades WHERE empreendimento_id=e.id) as total_unidades,
      (SELECT COUNT(*) FROM unidades WHERE empreendimento_id=e.id AND status='vendido') as unidades_vendidas,
      (SELECT COUNT(*) FROM unidades WHERE empreendimento_id=e.id AND status='reservado') as unidades_reservadas,
      (SELECT COUNT(*) FROM unidades WHERE empreendimento_id=e.id AND status='disponivel') as unidades_disponiveis,
      (SELECT COALESCE(SUM(valor),0) FROM vendas WHERE empreendimento_id=e.id AND status='ativo') as vgv_vendido,
      (SELECT COUNT(*) FROM vendas WHERE empreendimento_id=e.id AND status='ativo') as total_vendas
    FROM empreendimentos e
    WHERE e.cliente_id=?
    ORDER BY e.criado_em DESC
  `).all(clienteId);

  // Detalhes por empreendimento
  const detalhes = empreendimentos.map(emp => {
    const vendas = db.prepare(`
      SELECT v.id, v.data_venda, v.imovel, v.valor,
             v.comissao_corretor_pct, v.comissao_corretor_valor, v.comissao_corretor_status,
             v.comissao_corretor_data_pagamento, v.comissao_corretor_valor_pago,
             v.percentual_r2x, v.comissao_r2x,
             c.nome as corretor_nome, c.imobiliaria,
             -- Status de recebimento da comissão R2X a partir de financeiro_entradas
             (SELECT CASE
                WHEN COUNT(fe.id) = 0 THEN 'pendente'
                WHEN SUM(CASE WHEN fe.status='recebido' THEN 1 ELSE 0 END) = COUNT(fe.id) THEN 'recebido'
                WHEN SUM(CASE WHEN fe.status='recebido' THEN 1 ELSE 0 END) > 0 THEN 'parcial'
                ELSE 'pendente' END
              FROM financeiro_entradas fe WHERE fe.venda_id=v.id AND fe.tipo='comissao_venda'
             ) as comissao_r2x_status,
             (SELECT COALESCE(SUM(CASE WHEN fe.status='recebido' THEN fe.valor ELSE 0 END),0)
              FROM financeiro_entradas fe WHERE fe.venda_id=v.id AND fe.tipo='comissao_venda'
             ) as comissao_r2x_recebido,
             (SELECT MAX(fe.data_recebimento)
              FROM financeiro_entradas fe WHERE fe.venda_id=v.id AND fe.tipo='comissao_venda' AND fe.status='recebido'
             ) as comissao_r2x_data_recebimento
      FROM vendas v
      LEFT JOIN corretores c ON c.id = v.corretor_id
      WHERE v.empreendimento_id=? AND v.status='ativo'
      ORDER BY v.data_venda DESC
    `).all(emp.id);

    const checklist = db.prepare(`
      SELECT material, responsavel, data_entrega, status
      FROM checklist_marketing
      WHERE empreendimento_id=?
      ORDER BY ordem
    `).all(emp.id);

    return { ...emp, vendas, checklist };
  });

  // Ranking de corretores (todas as vendas dos empreendimentos do incorporador)
  const allEmpIds = empreendimentos.map(e => e.id);
  const rankingRows = allEmpIds.length ? db.prepare(`
    SELECT c.nome as corretor_nome, c.imobiliaria,
           COUNT(*) as total_vendas,
           SUM(v.valor) as total_vgv,
           SUM(COALESCE(v.comissao_corretor_valor,0)) as total_comissao_corretor,
           SUM(CASE WHEN v.comissao_corretor_status='pago' THEN COALESCE(v.comissao_corretor_valor,0) ELSE 0 END) as comissao_paga,
           SUM(CASE WHEN v.comissao_corretor_status!='pago' THEN COALESCE(v.comissao_corretor_valor,0) ELSE 0 END) as comissao_pendente
    FROM vendas v
    LEFT JOIN corretores c ON c.id = v.corretor_id
    WHERE v.empreendimento_id IN (${allEmpIds.map(()=>'?').join(',')}) AND v.status='ativo'
    GROUP BY v.corretor_id
    ORDER BY total_vendas DESC, total_vgv DESC
  `).all(...allEmpIds) : [];

  // KPIs globais — usa num_unidades (campo do cadastro) como total oficial
  const totalUnidades = empreendimentos.reduce((s, e) => s + (e.num_unidades||e.total_unidades||0), 0);
  const totalVendidas = empreendimentos.reduce((s, e) => s + (e.unidades_vendidas||0), 0);
  const totalReservadas = empreendimentos.reduce((s, e) => s + (e.unidades_reservadas||0), 0);
  const vgvTotal = empreendimentos.reduce((s, e) => s + (e.vgv_estimado||0), 0);
  const vgvVendido = empreendimentos.reduce((s, e) => s + (e.vgv_vendido||0), 0);

  ok(res, {
    cliente,
    empreendimentos: detalhes,
    ranking: rankingRows,
    kpis: { totalUnidades, totalVendidas, totalReservadas, vgvTotal, vgvVendido,
            totalEmpreendimentos: empreendimentos.length }
  });
});

// Incorporador pode marcar comissão do corretor como paga (total ou parcial)
app.put('/api/incorporador/vendas/:id/comissao-corretor', (req, res) => {
  const clienteId = guardaIncorporador(req, res);
  if (!clienteId) return;
  const vendaId = parseInt(req.params.id);
  const { status, data_pagamento, valor_pago } = req.body;
  if (!['pendente','parcial','pago'].includes(status)) return err(res, 'Status inválido');
  // Verifica que a venda pertence a um empreendimento deste incorporador
  const venda = db.prepare(`
    SELECT v.id, v.comissao_corretor_valor FROM vendas v
    JOIN empreendimentos e ON e.id = v.empreendimento_id
    WHERE v.id=? AND e.cliente_id=?
  `).get(vendaId, clienteId);
  if (!venda) return err(res, 'Venda não encontrada ou sem permissão', 403);

  const valorPago = parseFloat(valor_pago) || 0;
  // Auto-determina status se não enviado explicitamente
  let statusFinal = status;
  if (status === 'pago' && valorPago > 0 && valorPago < (venda.comissao_corretor_valor || 0)) {
    statusFinal = 'parcial';
  }

  db.prepare(`UPDATE vendas SET comissao_corretor_status=?, comissao_corretor_data_pagamento=?,
              comissao_corretor_valor_pago=? WHERE id=?`)
    .run(statusFinal, data_pagamento || null, valorPago || null, vendaId);
  ok(res, {});
});

// ─── EXTRAÇÃO DE CONTRATO COM IA ─────────────────────────────────────────────

const IMAGENS_ACEITAS = ['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','image/gif'];
const uploadContrato = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
      .concat(IMAGENS_ACEITAS)
      .includes(file.mimetype) ||
      file.originalname.toLowerCase().endsWith('.pdf') ||
      file.originalname.toLowerCase().endsWith('.docx');
    cb(null, ok);
  }
});

async function extrairTextoDocx(buffer) {
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml')?.asText() || '';
  // Remove tags XML e preserva quebras de parágrafo
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p>')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

app.post('/api/vendas/extrair-contrato', uploadContrato.single('contrato'), async (req, res) => {
  if (!req.file) return err(res, 'Arquivo não enviado');
  if (!openai) return err(res, 'Chave OpenAI não configurada no servidor');

  try {
    const mime = req.file.mimetype;
    const nome = req.file.originalname.toLowerCase();
    const ehImagem = IMAGENS_ACEITAS.includes(mime) ||
      ['.jpg','.jpeg','.png','.webp','.heic','.heif','.gif'].some(ext => nome.endsWith(ext));

    const promptSistema = `Você é um assistente especializado em contratos imobiliários brasileiros.
Leia o documento e extraia todas as informações no formato JSON.

Retorne APENAS um objeto JSON válido com estes campos (use null se não encontrar):
{
  "comprador_nome": "nome completo do comprador/cliente",
  "comprador_cpf": "CPF do comprador (apenas números ou formatado)",
  "comprador_telefone": "telefone do comprador (apenas números, com DDD)",
  "comprador_email": "email do comprador",
  "comprador_cidade": "cidade do comprador",
  "comprador_estado": "UF do comprador (2 letras)",
  "imovel": "identificação do imóvel (lote, quadra, unidade, bloco, apartamento etc)",
  "valor": número sem formatação (ex: 185000.00),
  "data_venda": "data de assinatura/venda no formato YYYY-MM-DD",
  "empreendimento": "nome do empreendimento/loteamento/condomínio",
  "corretor": "nome do corretor/intermediário se mencionado",
  "valor_entrada": número sem formatação — valor total da entrada/ato/sinal (ex: 30000.00). Se não houver, null,
  "entrada_parcelas": array de objetos com as parcelas da entrada. Cada objeto: {"data": "YYYY-MM-DD", "valor": número}. Se a entrada for à vista, array com um único objeto. Se parcelada, um objeto por parcela. Se não houver entrada, null,
  "observacoes": "outras informações relevantes em até 2 linhas"
}

IMPORTANTE sobre entrada_parcelas:
- Procure por termos como: entrada, ato, sinal, parcelas de entrada, pagamento inicial, 1ª parcela, 2ª parcela etc.
- Se encontrar datas de pagamento da entrada, inclua todas no array.
- Se encontrar apenas o valor total sem datas, use a data da assinatura como data da parcela.`;

    let completion;

    if (ehImagem) {
      // Visão direta: envia a imagem para GPT-4o que lê o texto visualmente
      const mimeReal = mime.startsWith('image/') ? mime : 'image/jpeg';
      const b64 = req.file.buffer.toString('base64');
      completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1200,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: promptSistema },
            { type: 'image_url', image_url: { url: `data:${mimeReal};base64,${b64}`, detail: 'high' } }
          ]
        }],
      });
    } else {
      // Texto: extrai do PDF ou DOCX e envia como texto
      let texto = '';
      if (mime === 'application/pdf' || nome.endsWith('.pdf')) {
        const parsed = await pdfParse(req.file.buffer);
        texto = parsed.text;
      } else if (nome.endsWith('.docx') || mime.includes('wordprocessingml')) {
        texto = await extrairTextoDocx(req.file.buffer);
      } else {
        return err(res, 'Formato não suportado. Envie PDF, DOCX ou imagem (JPG, PNG, WEBP, HEIC).');
      }
      if (!texto || texto.length < 50) return err(res, 'Não foi possível extrair texto do arquivo');
      const textoLimitado = texto.slice(0, 12000);
      completion = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        max_tokens: 1000,
        temperature: 0,
        messages: [{ role: 'user', content: `${promptSistema}\n\nCONTRATO:\n${textoLimitado}` }],
      });
    }

    const resposta = completion.choices[0].message.content.trim();

    // Extrai o JSON da resposta
    const jsonMatch = resposta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return err(res, 'IA não retornou dados estruturados');

    const dados = JSON.parse(jsonMatch[0]);

    // Tenta criar/atualizar lead automaticamente
    let lead_id = null;
    let lead_criado = false;
    if (dados.comprador_nome || dados.comprador_telefone) {
      const tel = dados.comprador_telefone ? dados.comprador_telefone.replace(/\D/g,'') : null;

      // Busca lead existente pelo telefone ou nome
      let leadExistente = null;
      if (tel) leadExistente = db.prepare('SELECT id FROM leads WHERE telefone=?').get(tel);
      if (!leadExistente && dados.comprador_nome) {
        leadExistente = db.prepare('SELECT id FROM leads WHERE nome=? LIMIT 1').get(dados.comprador_nome);
      }

      if (leadExistente) {
        lead_id = leadExistente.id;
        // Atualiza campos vazios do lead existente
        db.prepare(`UPDATE leads SET
          nome = COALESCE(NULLIF(nome,''), ?),
          telefone = COALESCE(NULLIF(telefone,''), ?),
          email = COALESCE(NULLIF(email,''), ?),
          cidade = COALESCE(NULLIF(cidade,''), ?),
          cpf = COALESCE(NULLIF(cpf,''), ?),
          status = CASE WHEN status='novo' THEN 'vendido' ELSE status END,
          atualizado_em = datetime('now')
          WHERE id=?`)
          .run(dados.comprador_nome||null, tel, dados.comprador_email||null,
               dados.comprador_cidade||null, dados.comprador_cpf||null, lead_id);
      } else {
        // Cria novo lead
        const r2 = db.prepare(`INSERT INTO leads
          (nome, telefone, email, cidade, cpf, status, origem, empreendimento_interesse, observacoes)
          VALUES (?,?,?,?,?,'vendido','contrato',?,?)`)
          .run(dados.comprador_nome||null, tel, dados.comprador_email||null,
               dados.comprador_cidade||null, dados.comprador_cpf||null,
               dados.empreendimento||null,
               `Lead criado automaticamente via importação de contrato${dados.observacoes ? ': ' + dados.observacoes : ''}`);
        lead_id = r2.lastInsertRowid;
        lead_criado = true;
      }
    }

    ok(res, { ...dados, lead_id, lead_criado });

  } catch(e) {
    console.error('[extrair-contrato]', e.message);
    err(res, 'Erro ao processar contrato: ' + e.message);
  }
});

// ─── LEITURA DE PLANTA URBANÍSTICA COM IA ────────────────────────────────────

const uploadPlanta = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
  fileFilter: (req, file, cb) => {
    const aceito = ['application/pdf'].concat(IMAGENS_ACEITAS).includes(file.mimetype) ||
      file.originalname.toLowerCase().endsWith('.pdf') ||
      ['.jpg','.jpeg','.png','.webp','.heic','.heif'].some(e => file.originalname.toLowerCase().endsWith(e));
    cb(null, aceito);
  }
});

app.post('/api/empreendimentos/:id/analisar-planta', uploadPlanta.single('planta'), async (req, res) => {
  if (!req.file) return err(res, 'Arquivo não enviado');
  if (!openai)   return err(res, 'Chave OpenAI não configurada no servidor');

  try {
    const mime = req.file.mimetype;
    const nome = req.file.originalname.toLowerCase();
    const ehImagem = IMAGENS_ACEITAS.includes(mime) ||
      ['.jpg','.jpeg','.png','.webp','.heic','.heif'].some(e => nome.endsWith(e));

    const prompt = `Você é um especialista em análise de plantas urbanísticas e loteamentos brasileiros.

Analise este documento e extraia TODOS os lotes/unidades encontrados.

Retorne APENAS um objeto JSON válido com esta estrutura:
{
  "empreendimento": "nome do loteamento/empreendimento se visível, senão null",
  "tipo": "loteamento" ou "predio" — identifique pelo conteúdo,
  "unidades": [
    { "quadra": "número ou letra da quadra (string), null se não houver", "lote": "número ou identificação do lote/apto/unidade (string)", "area_m2": número da área em m² (sem formatação, ex: 300.00), null se não encontrada },
    ...
  ]
}

REGRAS IMPORTANTES:
- Extraia TODOS os lotes, não apenas alguns exemplos
- Se houver uma tabela de áreas/lotes, priorize ela
- Quadra pode ser número (1, 2, 3) ou letra (A, B, C)
- Lote é o identificador da unidade (número, letra ou combinação)
- area_m2 deve ser número decimal (ex: 300.00, não "300,00 m²")
- Se o documento tiver múltiplas páginas/seções, combine todos os lotes
- Para plantas de prédio: quadra = andar, lote = número do apartamento
- Ignore lotes de uso comum, praças, vias (foque em lotes vendáveis)`;

    let completion;
    let fonte = 'visao';

    if (ehImagem) {
      const mimeReal = mime.startsWith('image/') ? mime : 'image/jpeg';
      const b64 = req.file.buffer.toString('base64');
      completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4000,
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeReal};base64,${b64}`, detail: 'high' } }
        ]}],
      });
    } else {
      // PDF: tenta extração de texto primeiro
      let texto = '';
      let erroExtracao = null;
      try {
        const parsed = await pdfParse(req.file.buffer);
        texto = parsed.text || '';
      } catch(e) {
        erroExtracao = e.message;
        console.error('[analisar-planta] pdf-parse erro:', e.message);
      }

      const charsUteis = (texto || '').replace(/\s/g, '').length;
      console.log(`[analisar-planta] PDF chars úteis: ${charsUteis}`);

      if (charsUteis >= 20) {
        // Tem texto suficiente — usa GPT-4o com o texto extraído
        fonte = 'texto';
        completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 16000,   // plantas grandes podem ter centenas de lotes
          temperature: 0,
          messages: [{ role: 'user', content: `${prompt}\n\nCONTEÚDO DO DOCUMENTO:\n${texto.slice(0, 40000)}` }],
        });
      } else {
        // PDF sem texto legível (digitalizado ou vetorial puro) —
        // usa a Files API da OpenAI que aceita PDF nativamente
        try {
          const { toFile } = require('openai');
          const arquivoPdf = await toFile(req.file.buffer, 'planta.pdf', { type: 'application/pdf' });
          const fileUpload = await openai.files.create({ file: arquivoPdf, purpose: 'user_data' });
          fonte = 'visao_pdf';
          completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 16000,
            temperature: 0,
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'file', file: { file_id: fileUpload.id } }
            ]}],
          });
          // Remove o arquivo após uso para não acumular na conta
          openai.files.del(fileUpload.id).catch(() => {});
        } catch(fileErr) {
          console.error('[analisar-planta] Files API erro:', fileErr.message);
          const motivo = erroExtracao ? ` (erro pdf-parse: ${erroExtracao})` : ` (${charsUteis} chars extraídos)`;
          return err(res, `PDF sem texto legível${motivo}. Exporte uma página da planta como JPG ou PNG e envie a imagem — o sistema usa IA Vision para ler visualmente.`);
        }
      }
    }

    const resposta = completion.choices[0].message.content.trim();

    // Extrai o JSON da resposta (pode vir com markdown ```json ... ```)
    const jsonMatch = resposta.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return err(res, 'IA não retornou dados estruturados. Tente com uma imagem (JPG/PNG) da planta.');

    // Tenta parsear; se truncado, tenta recuperar os itens completos que já vieram
    let dados;
    try {
      dados = JSON.parse(jsonMatch[0]);
    } catch(parseErr) {
      // JSON truncado (max_tokens atingido) — recupera os objetos completos do array
      console.warn('[analisar-planta] JSON truncado, tentando recuperar parcialmente...');
      const parcial = jsonMatch[0];
      // Extrai todos os objetos completos do array "unidades" já recebidos
      const itemsMatch = parcial.match(/\{\s*"quadra"\s*:[\s\S]*?\}/g) ||
                         parcial.match(/\{\s*"lote"\s*:[\s\S]*?\}/g);
      if (!itemsMatch || !itemsMatch.length) {
        return err(res, `Resposta da IA foi cortada e não foi possível recuperar os lotes. A planta tem muitos lotes — tente enviar em partes (ex: só as páginas com a tabela de áreas).`);
      }
      const unidadesRecuperadas = [];
      for (const item of itemsMatch) {
        try { unidadesRecuperadas.push(JSON.parse(item)); } catch(_) {}
      }
      dados = { unidades: unidadesRecuperadas, empreendimento: null, tipo: 'loteamento' };
      console.log(`[analisar-planta] Recuperados ${unidadesRecuperadas.length} lotes do JSON truncado`);
    }

    const unidades = (dados.unidades || []).filter(u => u.lote);

    if (!unidades.length) return err(res, 'Nenhum lote identificado no arquivo. Tente enviar como imagem JPG de melhor qualidade.');

    ok(res, { unidades, empreendimento: dados.empreendimento, tipo: dados.tipo, fonte, total: unidades.length });
  } catch(e) {
    console.error('[analisar-planta]', e.message);
    err(res, 'Erro ao analisar planta: ' + e.message);
  }
});

// Importação em lote de unidades (sem limpar existentes vendidas/reservadas)
app.post('/api/empreendimentos/:id/unidades/importar-lote', (req, res) => {
  const empId = parseInt(req.params.id);
  const { unidades } = req.body;
  if (!Array.isArray(unidades) || !unidades.length) return err(res, 'Lista de unidades vazia');

  const insert = db.prepare(`INSERT INTO unidades (empreendimento_id,quadra,lote,area_m2,preco,status) VALUES (?,?,?,?,?,'disponivel')`);
  let importadas = 0;

  const run = db.transaction(() => {
    for (const u of unidades) {
      if (!u.lote) continue;
      // Verifica se já existe lote+quadra (evita duplicatas)
      const existe = db.prepare(
        'SELECT id FROM unidades WHERE empreendimento_id=? AND lote=? AND (quadra=? OR (quadra IS NULL AND ? IS NULL))'
      ).get(empId, String(u.lote), u.quadra||null, u.quadra||null);
      if (existe) continue;
      insert.run(empId, u.quadra||null, String(u.lote), u.area_m2||null, u.preco||null);
      importadas++;
    }
  });
  run();

  const stats = db.prepare('SELECT COUNT(*) as total, COALESCE(SUM(preco),0) as vgv FROM unidades WHERE empreendimento_id=?').get(empId);
  db.prepare('UPDATE empreendimentos SET num_unidades=?, vgv_estimado=? WHERE id=?').run(stats.total, stats.vgv, empId);

  ok(res, { importadas, total: stats.total });
});

// ─── WEBHOOK — CAPTURA DE LEADS DE PORTAIS ────────────────────────────────────

const WEBHOOK_KEY = process.env.WEBHOOK_KEY || 'webhook-r2x-2026';

app.post('/api/webhook/lead', (req, res) => {
  const key = req.headers['x-webhook-key'] || req.query.key;
  if (key !== WEBHOOK_KEY) return res.status(401).json({ ok: false, error: 'Chave inválida' });
  const { nome, telefone, email, cidade, mensagem, empreendimento, origem } = req.body;
  if (!nome && !telefone) return err(res, 'Nome ou telefone obrigatório');
  const existe = telefone ? db.prepare('SELECT id FROM leads WHERE telefone=?').get(telefone) : null;
  if (existe) return res.json({ ok: true, data: { id: existe.id, duplicado: true } });
  const r = db.prepare('INSERT INTO leads(nome,telefone,email,cidade,empreendimento_interesse,origem,status,observacoes) VALUES(?,?,?,?,?,?,?,?)').run(
    nome||null, telefone||null, email||null, cidade||null,
    empreendimento||null, origem||'portal', 'novo',
    mensagem ? `Mensagem do portal: ${mensagem}` : null
  );
  ok(res, { id: r.lastInsertRowid });
});

// ─── BACKUP / RESTAURAÇÃO DO BANCO DE DADOS ──────────────────────────────────

const uploadBackup = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200 MB para backup

app.get('/api/admin/backup', (req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'crm.db')
      : path.join(__dirname, 'crm.db');
    const data = fs.readFileSync(dbPath);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="crm-backup-${date}.db"`);
    res.send(data);
  } catch (e) {
    console.error('[backup]', e);
    err(res, 'Erro ao gerar backup: ' + e.message);
  }
});

app.post('/api/admin/restaurar', uploadBackup.single('backup'), (req, res) => {
  try {
    if (!req.file) return err(res, 'Arquivo não enviado');
    // Valida magic bytes do SQLite
    const magic = req.file.buffer.slice(0, 15).toString('utf8');
    if (!magic.startsWith('SQLite format 3')) {
      return err(res, 'Arquivo inválido — envie apenas um backup .db gerado pelo CRM');
    }
    const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'crm.db')
      : path.join(__dirname, 'crm.db');
    // Salva backup do banco atual antes de substituir
    const bkpPath = dbPath.replace('.db', `-antes-restauracao-${Date.now()}.db`);
    try { fs.copyFileSync(dbPath, bkpPath); } catch(_) {}
    // Substitui o banco e reinicia o processo (Railway reinicia automaticamente)
    fs.writeFileSync(dbPath, req.file.buffer);
    res.json({ ok: true, data: { mensagem: 'Banco restaurado com sucesso! O servidor vai reiniciar em 2 segundos.' } });
    setTimeout(() => process.exit(0), 2000);
  } catch (e) {
    console.error('[restaurar]', e);
    err(res, 'Erro ao restaurar: ' + e.message);
  }
});

// ─── PLUGGY OPEN FINANCE ──────────────────────────────────────────────────────

const PLUGGY_BASE = 'https://api.pluggy.ai';
let _pluggyApiKey = null;
let _pluggyApiKeyExpiry = 0;

async function getPluggyApiKey() {
  if (_pluggyApiKey && Date.now() < _pluggyApiKeyExpiry) return _pluggyApiKey;
  const clientId     = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET não configurados');
  const res  = await fetch(`${PLUGGY_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret })
  });
  if (!res.ok) throw new Error(`Pluggy auth falhou: ${res.status}`);
  const data = await res.json();
  _pluggyApiKey = data.apiKey;
  _pluggyApiKeyExpiry = Date.now() + 100 * 60 * 1000; // 100 min (token expira em 2h)
  return _pluggyApiKey;
}

async function pluggyFetch(path, options = {}) {
  const apiKey = await getPluggyApiKey();
  const res = await fetch(`${PLUGGY_BASE}${path}`, {
    ...options,
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', ...(options.headers||{}) }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pluggy ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// Diagnóstico: testa se credenciais estão ok
app.get('/api/pluggy/test', async (req, res) => {
  try {
    const clientId     = process.env.PLUGGY_CLIENT_ID;
    const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.json({ ok: false, error: 'Variáveis PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET não configuradas no Railway' });
    }
    // Força nova autenticação
    _pluggyApiKey = null; _pluggyApiKeyExpiry = 0;
    const apiKey = await getPluggyApiKey();
    res.json({ ok: true, data: { msg: 'Credenciais OK', apiKey: apiKey.slice(0,8) + '...' } });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Debug: verifica transações raw do Pluggy (remover depois)
app.get('/api/pluggy/debug-tx', async (req, res) => {
  try {
    const { accountId } = req.query;
    if (!accountId) return err(res, 'accountId obrigatório');
    // Sem filtro de data — traz tudo
    const raw = await pluggyFetch(`/transactions?accountId=${accountId}&pageSize=20`);
    res.json({ ok: true, data: raw });
  } catch(e) { err(res, e.message); }
});

// Gera token de conexão para o widget
app.get('/api/pluggy/connect-token', async (req, res) => {
  try {
    const { itemId } = req.query;
    const body = itemId ? { itemId } : {};
    const data = await pluggyFetch('/connect_token', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    // Pluggy pode retornar accessToken ou connectToken dependendo da versão
    const token = data.accessToken || data.connectToken || data.token;
    if (!token) throw new Error('Pluggy não retornou token: ' + JSON.stringify(data));
    res.json({ ok: true, data: { accessToken: token } });
  } catch(e) {
    console.error('[pluggy connect-token]', e.message);
    err(res, e.message);
  }
});

// Status de um item específico (para polling após conexão)
app.get('/api/pluggy/items/:itemId/status', async (req, res) => {
  try {
    const { itemId } = req.params;
    // Busca status na Pluggy (fonte da verdade)
    const item = await pluggyFetch(`/items/${itemId}`);
    const status = item.status || 'UNKNOWN';
    // Atualiza status local
    db.prepare(`UPDATE pluggy_items SET status=? WHERE item_id=?`).run(status, itemId);
    res.json({ ok: true, data: { status, itemId, executionStatus: item.executionStatus } });
  } catch(e) {
    // Se falhar na Pluggy, retorna status local
    const local = db.prepare(`SELECT status FROM pluggy_items WHERE item_id=?`).get(itemId);
    res.json({ ok: true, data: { status: local?.status || 'UNKNOWN', source: 'cache' } });
  }
});

// Lista items (conexões bancárias) salvos
app.get('/api/pluggy/items', (req, res) => {
  try {
    const items = db.prepare('SELECT * FROM pluggy_items ORDER BY criado_em DESC').all();
    // Para cada item, busca contas associadas
    const result = items.map(item => {
      const contas = db.prepare('SELECT * FROM pluggy_contas WHERE item_id=?').all(item.item_id);
      return { ...item, contas };
    });
    res.json({ ok: true, data: result });
  } catch(e) { err(res, e.message); }
});

// Salva item após conexão bem-sucedida no widget
app.post('/api/pluggy/items', async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return err(res, 'itemId obrigatório');

    // Busca detalhes do item
    const item = await pluggyFetch(`/items/${itemId}`);
    const nomeBanco = item.connector?.name || item.connector?.institutionUrl || `Banco #${itemId.slice(0,8)}`;
    const status = item.status || 'UPDATING';

    // Salva imediatamente (sem esperar sync)
    db.prepare(`INSERT OR REPLACE INTO pluggy_items (item_id, nome_banco, connector_id, status, ultimo_sync)
      VALUES (?,?,?,?,CURRENT_TIMESTAMP)`)
      .run(itemId, nomeBanco, item.connector?.id || null, status);

    // Se já está UPDATED, sincroniza em background (não bloqueia resposta)
    if (status === 'UPDATED') {
      _pluggySyncItem(itemId).catch(e => console.error('[pluggy bg sync]', e.message));
    }
    // Se UPDATING, o frontend vai fazer polling via /items/:id/status e chamar /sync quando pronto

    res.json({ ok: true, data: { itemId, nomeBanco, status } });
  } catch(e) {
    console.error('[pluggy items POST]', e.message);
    err(res, e.message);
  }
});

// Remove uma conexão bancária
app.delete('/api/pluggy/items/:itemId', async (req, res) => {
  try {
    const { itemId } = req.params;
    // Tenta deletar na Pluggy (best-effort)
    try { await pluggyFetch(`/items/${itemId}`, { method: 'DELETE' }); } catch(_) {}
    db.prepare('DELETE FROM pluggy_transacoes WHERE account_id IN (SELECT account_id FROM pluggy_contas WHERE item_id=?)').run(itemId);
    db.prepare('DELETE FROM pluggy_contas WHERE item_id=?').run(itemId);
    db.prepare('DELETE FROM pluggy_items WHERE item_id=?').run(itemId);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

// Sincroniza saldos e transações de todos os items (ou de um específico)
app.post('/api/pluggy/sync', async (req, res) => {
  try {
    const { itemId } = req.body;
    const items = itemId
      ? [{ item_id: itemId }]
      : db.prepare('SELECT item_id FROM pluggy_items').all();
    const resultados = [];
    for (const item of items) {
      try {
        const r = await _pluggySyncItem(item.item_id);
        resultados.push({ itemId: item.item_id, ok: true, ...r });
      } catch(e) {
        resultados.push({ itemId: item.item_id, ok: false, error: e.message });
      }
    }
    res.json({ ok: true, data: resultados });
  } catch(e) { err(res, e.message); }
});

// Extrai dados de parcelamento da descrição quando não vem na API
function _extrairParcela(desc) {
  if (!desc) return null;
  // Formatos: "3/12", "03 DE 12", "PARC 3/12", "PARCELA 3 DE 12"
  const m = desc.match(/\b0?(\d{1,2})\s*(?:\/|DE)\s*0?(\d{1,2})\b/i);
  if (m) {
    const atual = parseInt(m[1]);
    const total = parseInt(m[2]);
    if (atual >= 1 && total >= 2 && atual <= total && total <= 72) {
      return { atual, total };
    }
  }
  return null;
}

async function _pluggySyncItem(itemId) {
  const hoje = new Date().toISOString().slice(0,10);
  const de90  = new Date(Date.now() - 90*24*3600*1000).toISOString().slice(0,10);
  const de365 = new Date(Date.now() - 365*24*3600*1000).toISOString().slice(0,10);

  const accountsResp = await pluggyFetch(`/accounts?itemId=${itemId}`);
  const accounts = accountsResp.results || accountsResp.accounts || [];
  let totalTxs = 0;

  for (const acc of accounts) {
    const isCartao = acc.type === 'CREDIT';
    const creditData = acc.creditData || {};

    db.prepare(`INSERT OR REPLACE INTO pluggy_contas
      (item_id, account_id, nome, tipo, subtipo, numero, saldo, saldo_bloqueado, moeda,
       limite_credito, fatura_atual, vencimento_fatura, fechamento_fatura, atualizado_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .run(itemId, acc.id, acc.name, acc.type, acc.subtype || null, acc.number || null,
        acc.balance || 0,
        (acc.balances?.blocked) || 0,
        acc.currencyCode || 'BRL',
        creditData.creditLimit || acc.creditLimit || 0,
        creditData.balanceCloseDate ? (acc.balance || 0) : 0,
        creditData.balanceCloseDate || null,
        creditData.balanceDueDate || null);

    try {
      // Cartão: busca 90 dias para capturar parcelas antigas em andamento
      // Usa 1 ano para cartão (captura parcelas longas) e 90 dias para conta bancária
      const from = isCartao ? de365 : de90;
      const txResp = await pluggyFetch(`/transactions?accountId=${acc.id}&from=${from}&to=${hoje}&pageSize=500`);
      const txs = txResp.results || txResp.transactions || [];
      totalTxs += txs.length;

      const insert = db.prepare(`
        INSERT OR IGNORE INTO pluggy_transacoes
          (transaction_id, account_id, descricao, descricao_raw, valor, data, tipo, categoria,
           parcela_atual, parcela_total, parcela_valor, merchant)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

      const updateParcela = db.prepare(`
        UPDATE pluggy_transacoes SET parcela_atual=?, parcela_total=?, parcela_valor=?
        WHERE transaction_id=? AND parcela_atual IS NULL`);

      const txBatch = db.transaction(list => {
        for (const t of list) {
          const desc = t.description || t.descriptionRaw || '';
          const rawDesc = t.descriptionRaw || null;
          const valor = Math.abs(t.amount || 0);
          const tipo = t.type || (t.amount < 0 ? 'DEBIT' : 'CREDIT');
          const data = (t.date || t.transactionDate || '').slice(0, 10);
          const cat = t.category || null;
          const merchant = t.merchant?.name || t.merchantName || null;

          // Metadados de parcelamento da API (mais preciso que regex)
          const ccMeta = t.creditCardMetadata || {};
          let parcAtual = ccMeta.installmentNumber || null;
          let parcTotal = ccMeta.totalInstallments || null;
          let parcValor = ccMeta.installmentValue || (parcTotal ? valor : null);

          // Fallback: extrai da descrição
          if (!parcAtual || !parcTotal) {
            const ext = _extrairParcela(desc);
            if (ext) { parcAtual = ext.atual; parcTotal = ext.total; parcValor = valor; }
          }

          insert.run(t.id, acc.id, desc, rawDesc, valor, data, tipo, cat,
            parcAtual, parcTotal, parcValor, merchant);

          // Atualiza parcelas se já existia sem esse dado
          if (parcAtual && parcTotal) {
            updateParcela.run(parcAtual, parcTotal, parcValor, t.id);
          }
        }
      });
      txBatch(txs);
    } catch(e) {
      console.error(`[pluggy sync tx] account ${acc.id}:`, e.message);
    }
  }

  db.prepare(`UPDATE pluggy_items SET status='UPDATED', ultimo_sync=CURRENT_TIMESTAMP WHERE item_id=?`).run(itemId);
  return { contas: accounts.length, transacoes: totalTxs };
}

// Lista contas com saldo
app.get('/api/pluggy/contas', (req, res) => {
  try {
    const contas = db.prepare(`
      SELECT c.*, i.nome_banco, i.status as item_status
      FROM pluggy_contas c JOIN pluggy_items i ON c.item_id=i.item_id
      ORDER BY i.nome_banco, c.nome`).all();
    res.json({ ok: true, data: contas });
  } catch(e) { err(res, e.message); }
});

// Transações de uma conta
app.get('/api/pluggy/transacoes', (req, res) => {
  try {
    const { accountId, mes } = req.query;
    let rows;
    if (accountId && mes) {
      rows = db.prepare(`SELECT * FROM pluggy_transacoes WHERE account_id=? AND strftime('%Y-%m',data)=? ORDER BY data DESC`).all(accountId, mes);
    } else if (accountId) {
      rows = db.prepare(`SELECT * FROM pluggy_transacoes WHERE account_id=? ORDER BY data DESC LIMIT 150`).all(accountId);
    } else if (mes) {
      rows = db.prepare(`SELECT t.*, c.nome as conta_nome, i.nome_banco FROM pluggy_transacoes t
        JOIN pluggy_contas c ON t.account_id=c.account_id
        JOIN pluggy_items i ON c.item_id=i.item_id
        WHERE strftime('%Y-%m',t.data)=? ORDER BY t.data DESC`).all(mes);
    } else {
      rows = db.prepare(`SELECT t.*, c.nome as conta_nome, i.nome_banco FROM pluggy_transacoes t
        JOIN pluggy_contas c ON t.account_id=c.account_id
        JOIN pluggy_items i ON c.item_id=i.item_id
        ORDER BY t.data DESC LIMIT 200`).all();
    }
    res.json({ ok: true, data: rows });
  } catch(e) { err(res, e.message); }
});

// Importa transações selecionadas para Gestão Pessoal
app.post('/api/pluggy/importar', (req, res) => {
  try {
    const { transacoes } = req.body; // [{ transaction_id, tipo, categoria, descricao, valor, data }]
    if (!Array.isArray(transacoes) || !transacoes.length) return err(res, 'Nenhuma transação enviada');
    let importadas = 0, erros = 0;
    const insertRec = db.prepare(`INSERT OR IGNORE INTO pessoal_receitas (descricao,categoria,valor,data,observacoes) VALUES (?,?,?,?,?)`);
    const insertDesp = db.prepare(`INSERT OR IGNORE INTO pessoal_despesas (descricao,categoria,valor,data,observacoes) VALUES (?,?,?,?,?)`);
    const markImportada = db.prepare(`UPDATE pluggy_transacoes SET importada=1 WHERE transaction_id=?`);
    const importAll = db.transaction(list => {
      for (const t of list) {
        try {
          if (t.tipo === 'CREDIT') {
            insertRec.run(t.descricao, t.categoria||'outros', t.valor, t.data, 'Importado do Pluggy');
          } else {
            insertDesp.run(t.descricao, _mapPluggyCategoria(t.categoria), t.valor, t.data, 'Importado do Pluggy');
          }
          markImportada.run(t.transaction_id);
          importadas++;
        } catch(_) { erros++; }
      }
    });
    importAll(transacoes);
    res.json({ ok: true, data: { importadas, erros } });
  } catch(e) { err(res, e.message); }
});

function _mapPluggyCategoria(cat) {
  if (!cat) return 'outros';
  const c = cat.toLowerCase();
  if (c.includes('alimenta') || c.includes('restaur') || c.includes('mercado')) return 'alimentacao';
  if (c.includes('transporte') || c.includes('uber') || c.includes('combustiv') || c.includes('posto')) return 'transporte';
  if (c.includes('moradia') || c.includes('aluguel') || c.includes('condominio') || c.includes('agua') || c.includes('luz') || c.includes('energia')) return 'moradia';
  if (c.includes('saude') || c.includes('farmac') || c.includes('medico') || c.includes('hospital')) return 'saude';
  if (c.includes('educa') || c.includes('escola') || c.includes('curso') || c.includes('livro')) return 'educacao';
  if (c.includes('lazer') || c.includes('entret') || c.includes('cinema') || c.includes('viagem') || c.includes('hotel')) return 'lazer';
  if (c.includes('invest') || c.includes('poupan') || c.includes('cdb') || c.includes('fundo')) return 'investimentos';
  if (c.includes('imposto') || c.includes('tributo') || c.includes('taxa')) return 'imposto';
  return 'outros';
}

// ── Importação de CSV bancário ────────────────────────────────────────────────
const CSV_VIRTUAL_ITEM_ID    = 'csv-import';
const CSV_VIRTUAL_ACCOUNT_ID = 'csv-cartao';

function _garantirContaCSV() {
  db.prepare(`INSERT OR IGNORE INTO pluggy_items(item_id, nome_banco, connector_id, status)
    VALUES(?,?,?,?)`).run(CSV_VIRTUAL_ITEM_ID, 'Importação CSV', 0, 'UPDATED');
  db.prepare(`INSERT OR IGNORE INTO pluggy_contas
    (item_id, account_id, nome, tipo, subtipo, saldo, moeda, atualizado_em)
    VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(CSV_VIRTUAL_ITEM_ID, CSV_VIRTUAL_ACCOUNT_ID, 'Cartão (CSV)', 'CREDIT', 'CREDIT_CARD', 0, 'BRL');
}

function _parseCsvLinhas(texto) {
  // Detecta separador: ponto-e-vírgula ou vírgula
  const sep = texto.split('\n')[0].includes(';') ? ';' : ',';
  return texto.trim().split('\n').map(l => {
    // Trata campos entre aspas com separadores dentro
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === sep && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cols.push(cur.trim());
    return cols;
  });
}

function _parseDateBR(s) {
  // DD/MM/YYYY → YYYY-MM-DD
  if (!s) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // YYYY-MM-DD já está certo
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  return null;
}

function _detectarFormato(header) {
  const h = header.toLowerCase();
  if (h.includes('date') && h.includes('title') && h.includes('amount'))    return 'nubank-credito';
  if (h.includes('data') && h.includes('valor') && h.includes('descri'))    return 'nubank-debito';
  if (h.includes('historico') || h.includes('histórico'))                    return 'itau';
  return 'generico';
}

app.post('/api/pluggy/importar-csv', upload.single('arquivo'), async (req, res) => {
  try {
    const csvText = req.file
      ? req.file.buffer.toString('utf8').replace(/\r/g,'')
      : (req.body.csvContent||'').replace(/\r/g,'');
    if (!csvText || csvText.trim().length < 10) return err(res, 'CSV vazio ou não enviado');

    const linhas = _parseCsvLinhas(csvText);
    if (linhas.length < 2) return err(res, 'CSV sem dados (mínimo cabeçalho + 1 linha)');

    const header = linhas[0].map(h => h.toLowerCase().trim());
    const formato = req.body.formato || _detectarFormato(linhas[0].join(','));

    _garantirContaCSV();

    const accountId = req.body.accountId || CSV_VIRTUAL_ACCOUNT_ID;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO pluggy_transacoes
        (transaction_id, account_id, descricao, descricao_raw, valor, data, tipo, categoria, merchant)
      VALUES (?,?,?,?,?,?,?,?,?)`);

    let importadas = 0, ignoradas = 0;
    const txs = [];

    for (let i = 1; i < linhas.length; i++) {
      const cols = linhas[i];
      if (!cols || cols.every(c => !c)) continue;
      try {
        let data, desc, valor, tipo, cat, merchant;

        if (formato === 'nubank-credito') {
          // date,category,title,amount
          const iDate   = header.indexOf('date');
          const iCat    = header.indexOf('category');
          const iTitle  = header.indexOf('title');
          const iAmt    = header.indexOf('amount');
          if (iDate<0||iAmt<0) { ignoradas++; continue; }
          data  = cols[iDate]?.slice(0,10);
          cat   = cols[iCat] || 'Outros';
          desc  = cols[iTitle] || cat;
          valor = parseFloat((cols[iAmt]||'0').replace(',','.'));
          if (isNaN(valor)||valor===0) { ignoradas++; continue; }
          tipo  = valor < 0 ? 'CREDIT' : 'DEBIT'; // crédito no extrato = pagamento
          valor = Math.abs(valor);
          merchant = desc;

        } else if (formato === 'nubank-debito') {
          // Data,Valor,Identificador,Descrição
          const iData  = header.findIndex(h=>h.includes('data'));
          const iValor = header.findIndex(h=>h.includes('valor'));
          const iDesc  = header.findIndex(h=>h.includes('descri'));
          if (iData<0||iValor<0) { ignoradas++; continue; }
          data  = _parseDateBR(cols[iData]);
          desc  = cols[iDesc] || 'Lançamento';
          valor = parseFloat((cols[iValor]||'0').replace(',','.'));
          if (isNaN(valor)||valor===0) { ignoradas++; continue; }
          tipo  = valor < 0 ? 'DEBIT' : 'CREDIT';
          valor = Math.abs(valor);
          cat   = _mapPluggyCategoria(desc);
          merchant = desc;

        } else if (formato === 'itau') {
          // Data;Histórico;Docto.;Crédito;Débito;Saldo
          const iData  = header.findIndex(h=>h.includes('data'));
          const iHist  = header.findIndex(h=>h.includes('hist'));
          const iCred  = header.findIndex(h=>h.includes('cr'));
          const iDeb   = header.findIndex(h=>h.includes('d'));
          if (iData<0) { ignoradas++; continue; }
          data  = _parseDateBR(cols[iData]);
          desc  = cols[iHist] || 'Lançamento';
          const cred = parseFloat((cols[iCred]||'0').replace('.','').replace(',','.')) || 0;
          const deb  = parseFloat((cols[iDeb] ||'0').replace('.','').replace(',','.')) || 0;
          if (cred===0&&deb===0) { ignoradas++; continue; }
          tipo  = deb > 0 ? 'DEBIT' : 'CREDIT';
          valor = deb > 0 ? deb : cred;
          cat   = _mapPluggyCategoria(desc);
          merchant = desc;

        } else {
          // Genérico: tenta achar colunas por nome
          const iData  = header.findIndex(h=>h.includes('data')||h.includes('date'));
          const iValor = header.findIndex(h=>h.includes('valor')||h.includes('amount')||h.includes('vl'));
          const iDesc  = header.findIndex(h=>h.includes('descri')||h.includes('hist')||h.includes('title')||h.includes('memo'));
          if (iData<0||iValor<0) { ignoradas++; continue; }
          data  = _parseDateBR(cols[iData]) || cols[iData]?.slice(0,10);
          desc  = cols[iDesc] || 'Lançamento';
          valor = parseFloat((cols[iValor]||'0').replace(/\./g,'').replace(',','.'));
          if (isNaN(valor)||valor===0) { ignoradas++; continue; }
          tipo  = valor < 0 ? 'DEBIT' : 'CREDIT';
          valor = Math.abs(valor);
          cat   = _mapPluggyCategoria(desc);
          merchant = desc;
        }

        if (!data||!valor) { ignoradas++; continue; }
        // ID estável: hash da linha
        const txId = `csv-${accountId}-${data}-${desc.slice(0,20)}-${valor}`.replace(/\s/g,'-');
        txs.push([txId, accountId, desc, desc, valor, data, tipo, _mapPluggyCategoria(cat||desc), merchant]);
      } catch(_) { ignoradas++; }
    }

    const batch = db.transaction(list => {
      for (const t of list) {
        const r = insert.run(...t);
        if (r.changes > 0) importadas++;
        else ignoradas++;
      }
    });
    batch(txs);

    res.json({ ok: true, data: { importadas, ignoradas, formato, total: linhas.length - 1 } });
  } catch(e) { err(res, e.message); }
});

// ── Análise IA da fatura do cartão ───────────────────────────────────────────
app.post('/api/pluggy/analisar-fatura', async (req, res) => {
  try {
    if (!openai) return err(res, 'OpenAI não configurado');
    const { accountId, mes } = req.body;
    if (!accountId || !mes) return err(res, 'accountId e mes obrigatórios');

    // Verifica cache (validade: 6h)
    const cached = db.prepare(`SELECT analise_json, atualizado_em FROM pluggy_analise_cache WHERE mes=? AND account_id=?`).get(mes, accountId);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.atualizado_em).getTime();
      if (ageMs < 6 * 3600 * 1000) {
        return res.json({ ok: true, data: JSON.parse(cached.analise_json), cache: true });
      }
    }

    const txs = db.prepare(`
      SELECT descricao, valor, data, tipo, categoria, merchant, parcela_atual, parcela_total
      FROM pluggy_transacoes
      WHERE account_id=? AND strftime('%Y-%m',data)=? AND tipo='DEBIT'
      ORDER BY valor DESC LIMIT 200`).all(accountId, mes);

    if (!txs.length) return err(res, 'Nenhuma transação neste mês para analisar');

    const conta = db.prepare(`SELECT nome, nome_banco FROM pluggy_contas c JOIN pluggy_items i ON c.item_id=i.item_id WHERE account_id=?`).get(accountId);

    const prompt = `Você é um consultor financeiro pessoal. Analise as despesas do cartão de crédito "${conta?.nome || 'Cartão'}" (${conta?.nome_banco || ''}) referentes ao mês ${mes}.

TRANSAÇÕES (débitos):
${txs.map(t => `- ${t.data} | ${t.descricao}${t.merchant&&t.merchant!==t.descricao?` (${t.merchant})`:''}${t.parcela_atual?` [${t.parcela_atual}/${t.parcela_total}]`:''} | R$ ${t.valor.toFixed(2)} | Cat: ${t.categoria||'?'}`).join('\n')}

Responda em JSON válido com exatamente esta estrutura:
{
  "total_mes": <número>,
  "categorias": [{"nome":"<categoria>","total":<número>,"percentual":<número>,"transacoes":<count>,"cor":"<hex>"}],
  "insights": ["<frase curta de insight>"],
  "alertas": ["<frase de alerta se houver gastos excessivos>"],
  "recomendacoes": ["<recomendação prática>"],
  "resumo": "<parágrafo resumindo o perfil de gastos do mês>",
  "score_financeiro": <0-100>,
  "score_comentario": "<explicação do score>"
}

Use categorias em português: Alimentação, Transporte, Moradia, Saúde, Educação, Lazer & Entretenimento, Compras, Assinaturas, Viagem, Parcelas, Outros.
Cores sugeridas: use tons vibrantes distintos. Seja direto e útil. Identifique padrões, gastos recorrentes, parcelas.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 2000, temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });

    const analise = JSON.parse(completion.choices[0].message.content);
    db.prepare(`INSERT OR REPLACE INTO pluggy_analise_cache (mes, account_id, analise_json, atualizado_em) VALUES (?,?,?,CURRENT_TIMESTAMP)`)
      .run(mes, accountId, JSON.stringify(analise));
    res.json({ ok: true, data: analise });
  } catch(e) {
    console.error('[analisar-fatura]', e.message);
    err(res, e.message);
  }
});

// ── Parcelas em aberto e projeção futura ─────────────────────────────────────
app.get('/api/pluggy/parcelas', (req, res) => {
  try {
    const { accountId } = req.query;
    // Busca transações parceladas mais recentes de cada grupo (mesma descrição base)
    // Agrupa por "prefixo da descrição sem o número da parcela"
    const cond = accountId ? `AND account_id=?` : '';
    const args = accountId ? [accountId] : [];

    const txs = db.prepare(`
      SELECT transaction_id, account_id, descricao, merchant, valor, data,
             parcela_atual, parcela_total, parcela_valor
      FROM pluggy_transacoes
      WHERE parcela_total IS NOT NULL AND parcela_atual IS NOT NULL
      ${cond}
      ORDER BY data DESC`).all(...args);

    // Para cada série de parcelas, identifica o estado mais atual
    const series = {};
    for (const t of txs) {
      // Chave: remove número de parcela da descrição para agrupar
      const base = (t.descricao || '').replace(/\b\d{1,2}\/\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
      const key = `${t.account_id}::${base}::${t.parcela_total}`;
      if (!series[key] || t.parcela_atual > series[key].parcela_atual) {
        series[key] = t;
      }
    }

    const hoje = new Date();
    const parcelas = Object.values(series).map(t => {
      const restantes = t.parcela_total - t.parcela_atual;
      const valorRestante = restantes * (t.parcela_valor || t.valor);
      // Estima próximas datas (mensalmente a partir da data da última parcela registrada)
      const proximasDatas = [];
      for (let i = 1; i <= Math.min(restantes, 12); i++) {
        const d = new Date(t.data);
        d.setMonth(d.getMonth() + i);
        proximasDatas.push(d.toISOString().slice(0, 7)); // YYYY-MM
      }
      return {
        descricao: t.merchant || t.descricao,
        parcela_atual: t.parcela_atual,
        parcela_total: t.parcela_total,
        parcela_valor: t.parcela_valor || t.valor,
        restantes,
        valor_restante: valorRestante,
        ultima_data: t.data,
        proximas_faturas: proximasDatas,
        account_id: t.account_id
      };
    }).filter(p => p.restantes > 0).sort((a, b) => b.valor_restante - a.valor_restante);

    res.json({ ok: true, data: parcelas });
  } catch(e) { err(res, e.message); }
});

// ── Fluxo de caixa futuro (6 meses) ─────────────────────────────────────────
app.get('/api/pluggy/fluxo-futuro', (req, res) => {
  try {
    const hoje = new Date();

    // Monta 6 meses futuros (mês atual + 5)
    const meses = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });

    // Receitas recorrentes (pessoal_receitas)
    const receitasRec = db.prepare(`SELECT SUM(valor) as total FROM pessoal_receitas WHERE recorrente=1`).get()?.total || 0;

    // Despesas recorrentes (pessoal_despesas)
    const despesasRec = db.prepare(`SELECT SUM(valor) as total FROM pessoal_despesas WHERE recorrente=1`).get()?.total || 0;

    // Média mensal de gastos no cartão de crédito (últimos 3 meses, excluindo parcelas)
    const mediaCartao = (() => {
      const result = db.prepare(`
        SELECT AVG(total) as media FROM (
          SELECT strftime('%Y-%m',data) as mes, SUM(valor) as total
          FROM pluggy_transacoes
          WHERE tipo='DEBIT' AND parcela_atual IS NULL
            AND strftime('%Y-%m',data) < ?
          GROUP BY mes ORDER BY mes DESC LIMIT 3
        )`).get(meses[0]);
      return result?.media || 0;
    })();

    // Parcelas projetadas por mês
    const parcelasQuery = db.prepare(`
      SELECT t.account_id, t.descricao, t.parcela_atual, t.parcela_total, t.parcela_valor, t.valor, t.data
      FROM pluggy_transacoes t
      WHERE t.parcela_total IS NOT NULL AND t.parcela_atual IS NOT NULL
      ORDER BY t.data DESC`).all();

    // Agrega parcelas mais recentes por série
    const series = {};
    for (const t of parcelasQuery) {
      const base = (t.descricao || '').replace(/\b\d{1,2}\/\d{2}\b/g, '').trim();
      const key = `${t.account_id}::${base}::${t.parcela_total}`;
      if (!series[key] || t.parcela_atual > series[key].parcela_atual) series[key] = t;
    }

    // Projeta parcelas para cada mês futuro
    const parcelasPorMes = {};
    for (const mes of meses) parcelasPorMes[mes] = 0;
    for (const t of Object.values(series)) {
      const restantes = t.parcela_total - t.parcela_atual;
      const valorParc = t.parcela_valor || t.valor;
      for (let i = 1; i <= Math.min(restantes, 6); i++) {
        const d = new Date(t.data);
        d.setMonth(d.getMonth() + i);
        const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (parcelasPorMes[m] !== undefined) parcelasPorMes[m] += valorParc;
      }
    }

    // Receitas previstas (financeiro_entradas com data_prevista nos próximos 6 meses)
    const entradasPrevistas = db.prepare(`
      SELECT strftime('%Y-%m',data_prevista) as mes, SUM(valor) as total
      FROM financeiro_entradas
      WHERE status='pendente' AND data_prevista BETWEEN ? AND ?
      GROUP BY mes`).all(meses[0] + '-01', meses[5] + '-31');
    const entradasMap = {};
    entradasPrevistas.forEach(e => { entradasMap[e.mes] = (entradasMap[e.mes] || 0) + e.total; });

    // Monta fluxo mês a mês
    let saldoAcumulado = 0;
    const fluxo = meses.map((mes, idx) => {
      const receita = receitasRec + (entradasMap[mes] || 0);
      const despesaFixa = despesasRec;
      const parcelamento = parcelasPorMes[mes] || 0;
      const cartaoVariavel = idx === 0 ? mediaCartao * 0.8 : mediaCartao; // mês atual já parcialmente executado
      const totalSaida = despesaFixa + parcelamento + cartaoVariavel;
      const saldo = receita - totalSaida;
      saldoAcumulado += saldo;
      return {
        mes,
        receita: Math.round(receita * 100) / 100,
        despesa_fixa: Math.round(despesaFixa * 100) / 100,
        parcelamento: Math.round(parcelamento * 100) / 100,
        cartao_variavel: Math.round(cartaoVariavel * 100) / 100,
        total_saida: Math.round(totalSaida * 100) / 100,
        saldo_mes: Math.round(saldo * 100) / 100,
        saldo_acumulado: Math.round(saldoAcumulado * 100) / 100
      };
    });

    res.json({ ok: true, data: { fluxo, mediaCartao: Math.round(mediaCartao * 100) / 100, receitasRec, despesasRec } });
  } catch(e) {
    console.error('[fluxo-futuro]', e.message);
    err(res, e.message);
  }
});

// Resumo por categoria do cartão (para gráficos)
app.get('/api/pluggy/categorias', (req, res) => {
  try {
    const { accountId, mes } = req.query;
    if (!accountId || !mes) return err(res, 'accountId e mes obrigatórios');
    const cats = db.prepare(`
      SELECT COALESCE(categoria,'Outros') as categoria, SUM(valor) as total, COUNT(*) as qtd
      FROM pluggy_transacoes
      WHERE account_id=? AND strftime('%Y-%m',data)=? AND tipo='DEBIT'
      GROUP BY categoria ORDER BY total DESC`).all(accountId, mes);
    const tendencia = db.prepare(`
      SELECT strftime('%Y-%m',data) as mes, SUM(valor) as total
      FROM pluggy_transacoes
      WHERE account_id=? AND tipo='DEBIT'
      GROUP BY mes ORDER BY mes DESC LIMIT 6`).all(accountId);
    res.json({ ok: true, data: { categorias: cats, tendencia: tendencia.reverse() } });
  } catch(e) { err(res, e.message); }
});

// Webhook Pluggy — notificações automáticas de sincronização
app.post('/api/pluggy/webhook', async (req, res) => {
  try {
    const { event, itemId } = req.body || {};
    console.log('[Pluggy Webhook]', event, itemId, JSON.stringify(req.body).slice(0, 200));

    // Eventos que indicam que o item terminou de sincronizar
    const syncEvents = ['item/updated', 'transactions/created', 'transactions/updated'];
    if (syncEvents.includes(event) && itemId) {
      // Verificar se temos esse item na base
      const item = db.prepare('SELECT * FROM pluggy_items WHERE item_id=?').get(itemId);
      if (item) {
        // Atualizar status para UPDATED e disparar sync em background
        db.prepare('UPDATE pluggy_items SET status=? WHERE item_id=?').run('UPDATED', itemId);
        // Sync assíncrono (não bloqueia resposta ao Pluggy)
        _pluggySyncItem(itemId).then(() => {
          console.log('[Pluggy Webhook] Sync concluído para item', itemId);
        }).catch(e => {
          console.error('[Pluggy Webhook] Erro no sync:', e.message);
        });
      }
    }
    // Pluggy espera 200 rápido
    res.json({ ok: true });
  } catch(e) {
    console.error('[Pluggy Webhook]', e.message);
    res.json({ ok: true }); // sempre 200 pro Pluggy
  }
});

// ─── GESTÃO PESSOAL ───────────────────────────────────────────────────────────

// Dashboard pessoal
app.get('/api/pessoal/dashboard', (req, res) => {
  try {
    const hoje = new Date();
    const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;

    const receitaMes = db.prepare(`
      SELECT COALESCE(SUM(valor),0) as total FROM pessoal_receitas
      WHERE strftime('%Y-%m', data) = ?`).get(mesAtual)?.total || 0;
    const despesaMes = db.prepare(`
      SELECT COALESCE(SUM(valor),0) as total FROM pessoal_despesas
      WHERE strftime('%Y-%m', data) = ?`).get(mesAtual)?.total || 0;
    const receitaAno = db.prepare(`
      SELECT COALESCE(SUM(valor),0) as total FROM pessoal_receitas
      WHERE strftime('%Y', data) = ?`).get(String(hoje.getFullYear()))?.total || 0;
    const despesaAno = db.prepare(`
      SELECT COALESCE(SUM(valor),0) as total FROM pessoal_despesas
      WHERE strftime('%Y', data) = ?`).get(String(hoje.getFullYear()))?.total || 0;

    const metasAtivas = db.prepare(`SELECT COUNT(*) as n FROM pessoal_metas WHERE status='em_andamento'`).get()?.n || 0;
    const metasConc  = db.prepare(`SELECT COUNT(*) as n FROM pessoal_metas WHERE status='concluida'`).get()?.n || 0;
    const tarefasPend = db.prepare(`SELECT COUNT(*) as n FROM pessoal_tarefas WHERE concluida=0`).get()?.n || 0;
    const tarefasHoje = db.prepare(`SELECT COUNT(*) as n FROM pessoal_tarefas WHERE concluida=0 AND prazo=?`).get(hoje.toISOString().slice(0,10))?.n || 0;
    const tarefasAtrasadas = db.prepare(`SELECT COUNT(*) as n FROM pessoal_tarefas WHERE concluida=0 AND prazo < ?`).get(hoje.toISOString().slice(0,10))?.n || 0;

    // Receitas por categoria no mês
    const receitasCat = db.prepare(`
      SELECT categoria, SUM(valor) as total FROM pessoal_receitas
      WHERE strftime('%Y-%m', data) = ? GROUP BY categoria`).all(mesAtual);
    const despesasCat = db.prepare(`
      SELECT categoria, SUM(valor) as total FROM pessoal_despesas
      WHERE strftime('%Y-%m', data) = ? GROUP BY categoria`).all(mesAtual);

    // Evolução mensal dos últimos 6 meses
    const evolucao = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const m = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const r = db.prepare(`SELECT COALESCE(SUM(valor),0) as t FROM pessoal_receitas WHERE strftime('%Y-%m',data)=?`).get(m)?.t || 0;
      const s = db.prepare(`SELECT COALESCE(SUM(valor),0) as t FROM pessoal_despesas WHERE strftime('%Y-%m',data)=?`).get(m)?.t || 0;
      evolucao.push({ mes: m, receita: r, despesa: s, saldo: r - s });
    }

    res.json({ ok: true, data: {
      receitaMes, despesaMes, saldoMes: receitaMes - despesaMes,
      receitaAno, despesaAno, saldoAno: receitaAno - despesaAno,
      metasAtivas, metasConc, tarefasPend, tarefasHoje, tarefasAtrasadas,
      receitasCat, despesasCat, evolucao
    }});
  } catch(e) { err(res, e.message); }
});

// Receitas pessoais
app.get('/api/pessoal/receitas', (req, res) => {
  try {
    const { mes } = req.query;
    let rows;
    if (mes) {
      rows = db.prepare(`SELECT * FROM pessoal_receitas WHERE strftime('%Y-%m',data)=? ORDER BY data DESC`).all(mes);
    } else {
      rows = db.prepare(`SELECT * FROM pessoal_receitas ORDER BY data DESC LIMIT 200`).all();
    }
    res.json({ ok: true, data: rows });
  } catch(e) { err(res, e.message); }
});

app.post('/api/pessoal/receitas', (req, res) => {
  try {
    const { descricao, categoria, valor, data, recorrente, observacoes } = req.body;
    const r = db.prepare(`INSERT INTO pessoal_receitas (descricao,categoria,valor,data,recorrente,observacoes)
      VALUES (?,?,?,?,?,?)`).run(descricao, categoria||'outros', valor, data, recorrente?1:0, observacoes||null);
    res.json({ ok: true, data: { id: r.lastInsertRowid } });
  } catch(e) { err(res, e.message); }
});

app.put('/api/pessoal/receitas/:id', (req, res) => {
  try {
    const { descricao, categoria, valor, data, recorrente, observacoes } = req.body;
    db.prepare(`UPDATE pessoal_receitas SET descricao=?,categoria=?,valor=?,data=?,recorrente=?,observacoes=? WHERE id=?`)
      .run(descricao, categoria||'outros', valor, data, recorrente?1:0, observacoes||null, req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

app.delete('/api/pessoal/receitas/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM pessoal_receitas WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

// Despesas pessoais
app.get('/api/pessoal/despesas', (req, res) => {
  try {
    const { mes } = req.query;
    let rows;
    if (mes) {
      rows = db.prepare(`SELECT * FROM pessoal_despesas WHERE strftime('%Y-%m',data)=? ORDER BY data DESC`).all(mes);
    } else {
      rows = db.prepare(`SELECT * FROM pessoal_despesas ORDER BY data DESC LIMIT 200`).all();
    }
    res.json({ ok: true, data: rows });
  } catch(e) { err(res, e.message); }
});

app.post('/api/pessoal/despesas', (req, res) => {
  try {
    const { descricao, categoria, valor, data, recorrente, observacoes } = req.body;
    const r = db.prepare(`INSERT INTO pessoal_despesas (descricao,categoria,valor,data,recorrente,observacoes)
      VALUES (?,?,?,?,?,?)`).run(descricao, categoria||'outros', valor, data, recorrente?1:0, observacoes||null);
    res.json({ ok: true, data: { id: r.lastInsertRowid } });
  } catch(e) { err(res, e.message); }
});

app.put('/api/pessoal/despesas/:id', (req, res) => {
  try {
    const { descricao, categoria, valor, data, recorrente, observacoes } = req.body;
    db.prepare(`UPDATE pessoal_despesas SET descricao=?,categoria=?,valor=?,data=?,recorrente=?,observacoes=? WHERE id=?`)
      .run(descricao, categoria||'outros', valor, data, recorrente?1:0, observacoes||null, req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

app.delete('/api/pessoal/despesas/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM pessoal_despesas WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

// Metas pessoais
app.get('/api/pessoal/metas', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM pessoal_metas ORDER BY status ASC, prazo ASC`).all();
    res.json({ ok: true, data: rows });
  } catch(e) { err(res, e.message); }
});

app.post('/api/pessoal/metas', (req, res) => {
  try {
    const { titulo, categoria, valor_meta, valor_atual, prazo, status, descricao } = req.body;
    const r = db.prepare(`INSERT INTO pessoal_metas (titulo,categoria,valor_meta,valor_atual,prazo,status,descricao)
      VALUES (?,?,?,?,?,?,?)`).run(titulo, categoria||'financeira', valor_meta||0, valor_atual||0, prazo||null, status||'em_andamento', descricao||null);
    res.json({ ok: true, data: { id: r.lastInsertRowid } });
  } catch(e) { err(res, e.message); }
});

app.put('/api/pessoal/metas/:id', (req, res) => {
  try {
    const { titulo, categoria, valor_meta, valor_atual, prazo, status, descricao } = req.body;
    db.prepare(`UPDATE pessoal_metas SET titulo=?,categoria=?,valor_meta=?,valor_atual=?,prazo=?,status=?,descricao=? WHERE id=?`)
      .run(titulo, categoria||'financeira', valor_meta||0, valor_atual||0, prazo||null, status||'em_andamento', descricao||null, req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

app.delete('/api/pessoal/metas/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM pessoal_metas WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

// Tarefas pessoais
app.get('/api/pessoal/tarefas', (req, res) => {
  try {
    const { concluida } = req.query;
    let rows;
    if (concluida !== undefined) {
      rows = db.prepare(`SELECT * FROM pessoal_tarefas WHERE concluida=? ORDER BY
        CASE prioridade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, prazo ASC`).all(concluida==='1'?1:0);
    } else {
      rows = db.prepare(`SELECT * FROM pessoal_tarefas ORDER BY concluida ASC,
        CASE prioridade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END, prazo ASC`).all();
    }
    res.json({ ok: true, data: rows });
  } catch(e) { err(res, e.message); }
});

app.post('/api/pessoal/tarefas', (req, res) => {
  try {
    const { titulo, categoria, prioridade, prazo, descricao } = req.body;
    const r = db.prepare(`INSERT INTO pessoal_tarefas (titulo,categoria,prioridade,prazo,descricao)
      VALUES (?,?,?,?,?)`).run(titulo, categoria||'pessoal', prioridade||'media', prazo||null, descricao||null);
    res.json({ ok: true, data: { id: r.lastInsertRowid } });
  } catch(e) { err(res, e.message); }
});

app.put('/api/pessoal/tarefas/:id', (req, res) => {
  try {
    const { titulo, categoria, prioridade, prazo, concluida, descricao } = req.body;
    db.prepare(`UPDATE pessoal_tarefas SET titulo=?,categoria=?,prioridade=?,prazo=?,concluida=?,descricao=? WHERE id=?`)
      .run(titulo, categoria||'pessoal', prioridade||'media', prazo||null, concluida?1:0, descricao||null, req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

app.delete('/api/pessoal/tarefas/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM pessoal_tarefas WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

// Hábitos pessoais
app.get('/api/pessoal/habitos', (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0,10);
    const habitos = db.prepare(`SELECT * FROM pessoal_habitos WHERE ativo=1 ORDER BY nome`).all();
    const logs7 = db.prepare(`SELECT habito_id, data FROM pessoal_habitos_log
      WHERE data >= date('now','-6 days') ORDER BY data DESC`).all();
    const logMap = {};
    logs7.forEach(l => {
      if (!logMap[l.habito_id]) logMap[l.habito_id] = new Set();
      logMap[l.habito_id].add(l.data);
    });
    const result = habitos.map(h => ({
      ...h,
      feito_hoje: !!(logMap[h.id]?.has(hoje)),
      dias_semana: [...(logMap[h.id] || [])]
    }));
    res.json({ ok: true, data: result });
  } catch(e) { err(res, e.message); }
});

app.post('/api/pessoal/habitos', (req, res) => {
  try {
    const { nome, icone, frequencia } = req.body;
    const r = db.prepare(`INSERT INTO pessoal_habitos (nome,icone,frequencia) VALUES (?,?,?)`)
      .run(nome, icone||'✅', frequencia||'diario');
    res.json({ ok: true, data: { id: r.lastInsertRowid } });
  } catch(e) { err(res, e.message); }
});

app.put('/api/pessoal/habitos/:id', (req, res) => {
  try {
    const { nome, icone, frequencia, ativo } = req.body;
    db.prepare(`UPDATE pessoal_habitos SET nome=?,icone=?,frequencia=?,ativo=? WHERE id=?`)
      .run(nome, icone||'✅', frequencia||'diario', ativo!==undefined?ativo:1, req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

app.delete('/api/pessoal/habitos/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM pessoal_habitos WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch(e) { err(res, e.message); }
});

app.post('/api/pessoal/habitos/:id/toggle', (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0,10);
    const existing = db.prepare(`SELECT id FROM pessoal_habitos_log WHERE habito_id=? AND data=?`).get(req.params.id, hoje);
    if (existing) {
      db.prepare(`DELETE FROM pessoal_habitos_log WHERE habito_id=? AND data=?`).run(req.params.id, hoje);
      res.json({ ok: true, data: { feito: false } });
    } else {
      db.prepare(`INSERT OR IGNORE INTO pessoal_habitos_log (habito_id,data) VALUES (?,?)`).run(req.params.id, hoje);
      res.json({ ok: true, data: { feito: true } });
    }
  } catch(e) { err(res, e.message); }
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────

// Captura erros do multer (ex: arquivo muito grande) e outros erros de middleware
app.use((error, req, res, next) => {
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'Arquivo muito grande. Máximo 8 MB após compressão.' });
  }
  console.error('[error]', error?.message || error);
  if (!res.headersSent) res.status(500).json({ ok: false, error: 'Erro interno do servidor' });
});

// Evita que erros não capturados derrubem o processo
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`CRM R2X rodando em http://localhost:${PORT}`));
