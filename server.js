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

const APIs_PUBLICAS = ["/api/corretores/publico", "/api/leads/whatsapp", "/api/auth/login", "/api/webhook/lead", "/api/portal/"];

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
    SELECT e.*, c.razao_social as cliente_nome
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
  const { nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, origem, observacoes, aniversario } = req.body;
  const r = db.prepare(`INSERT INTO leads (nome,telefone,email,cidade,objetivo,faixa_investimento,prazo,empreendimento_interesse,empreendimento_id,corretor_id,status,origem,observacoes,aniversario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status || 'novo', origem || 'manual', observacoes, aniversario||null);
  ok(res, { id: r.lastInsertRowid });
});

app.put("/api/leads/:id", (req, res) => {
  const { nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, observacoes, aniversario } = req.body;
  db.prepare(`UPDATE leads SET nome=?,telefone=?,email=?,cidade=?,objetivo=?,faixa_investimento=?,prazo=?,empreendimento_interesse=?,empreendimento_id=?,corretor_id=?,status=?,observacoes=?,aniversario=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?`).run(nome, telefone, email, cidade, objetivo, faixa_investimento, prazo, empreendimento_interesse, empreendimento_id, corretor_id, status, observacoes, aniversario||null, req.params.id);
  ok(res, {});
});

app.delete("/api/leads/:id", (req, res) => {
  db.prepare("DELETE FROM leads WHERE id=?").run(req.params.id);
  ok(res, {});
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
           cl.razao_social as cliente_nome
    FROM vendas v
    LEFT JOIN leads l ON l.id = v.lead_id
    LEFT JOIN corretores c ON c.id = v.corretor_id
    LEFT JOIN empreendimentos e ON e.id = v.empreendimento_id
    LEFT JOIN clientes cl ON cl.id = v.cliente_id
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
  const { lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id, valor, data_venda, observacoes, comissao_corretor_pct, comissao_corretor_valor, comissao_corretor_status, valor_entrada, entrada_parcelas, percentual_r2x_override } = req.body;
  if (!valor || !data_venda) return err(res, "Valor e data obrigatórios");

  // Serializa parcelas de entrada como JSON
  const parcelasJson = entrada_parcelas && Array.isArray(entrada_parcelas) && entrada_parcelas.length > 0
    ? JSON.stringify(entrada_parcelas) : null;

  const r = db.prepare(`INSERT INTO vendas
    (lead_id,empreendimento_id,corretor_id,cliente_id,imovel,unidade_id,valor,data_venda,observacoes,status,
     comissao_corretor_pct,comissao_corretor_valor,comissao_corretor_status,valor_entrada,entrada_parcelas,percentual_r2x_override)
    VALUES (?,?,?,?,?,?,?,?,?,'ativo',?,?,?,?,?,?)`)
    .run(lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id || null,
         valor, data_venda, observacoes,
         comissao_corretor_pct||null, comissao_corretor_valor||null, comissao_corretor_status||'pendente',
         valor_entrada||null, parcelasJson, percentual_r2x_override||null);

  if (lead_id) db.prepare("UPDATE leads SET status='vendido' WHERE id=?").run(lead_id);
  if (unidade_id) db.prepare("UPDATE unidades SET status='vendido' WHERE id=?").run(unidade_id);

  const comissao = sincronizarComissaoVenda(r.lastInsertRowid);
  const aviso = (empreendimento_id && !comissao) ? 'Atenção: empreendimento sem % R2X cadastrado. Comissão não foi gerada.' : null;

  ok(res, { id: r.lastInsertRowid, comissao_r2x: comissao, aviso });
});

app.put("/api/vendas/:id", (req, res) => {
  const { lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id, valor, data_venda, status, observacoes, comissao_corretor_pct, comissao_corretor_valor, comissao_corretor_status, valor_entrada, entrada_parcelas, percentual_r2x_override } = req.body;
  const vendaAntiga = db.prepare("SELECT unidade_id, status FROM vendas WHERE id=?").get(req.params.id);

  // Serializa parcelas de entrada como JSON
  const parcelasJson = entrada_parcelas && Array.isArray(entrada_parcelas) && entrada_parcelas.length > 0
    ? JSON.stringify(entrada_parcelas) : null;

  db.prepare(`UPDATE vendas SET
    lead_id=?,empreendimento_id=?,corretor_id=?,cliente_id=?,imovel=?,unidade_id=?,valor=?,data_venda=?,
    status=?,observacoes=?,comissao_corretor_pct=?,comissao_corretor_valor=?,comissao_corretor_status=?,
    valor_entrada=?,entrada_parcelas=?,percentual_r2x_override=?
    WHERE id=?`)
    .run(lead_id, empreendimento_id, corretor_id, cliente_id, imovel, unidade_id || null,
         valor, data_venda, status, observacoes,
         comissao_corretor_pct||null, comissao_corretor_valor||null, comissao_corretor_status||'pendente',
         valor_entrada||null, parcelasJson, percentual_r2x_override||null,
         req.params.id);

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
  "total": número sem formatação ou null,
  "lancamentos": [
    {
      "data": "YYYY-MM-DD",
      "descricao": "descrição da compra exatamente como aparece na fatura",
      "valor": número positivo (ex: 150.00),
      "tipo": "debito" ou "credito"
    }
  ]
}

Regras:
- Inclua TODOS os lançamentos, inclusive tarifas, IOF, juros, pagamentos e créditos
- Para créditos/estornos, use tipo "credito" e valor positivo
- Para compras/débitos, use tipo "debito" e valor positivo
- Se a data aparecer apenas como dia/mês, use o ano do vencimento ou o ano atual
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
             v.percentual_r2x, v.comissao_r2x,
             c.nome as corretor_nome, c.imobiliaria
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

  // KPIs globais
  const totalUnidades = empreendimentos.reduce((s, e) => s + (e.total_unidades||0), 0);
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
