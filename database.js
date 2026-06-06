const Database = require("better-sqlite3");
const path = require("path");
// RAILWAY_VOLUME_MOUNT_PATH é definido automaticamente quando um volume é anexado
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "crm.db")
  : "crm.db";
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    razao_social TEXT NOT NULL,
    cnpj TEXT,
    nome_contato TEXT,
    telefone TEXT,
    email TEXT,
    cidade TEXT,
    estado TEXT,
    aniversario TEXT,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS empreendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER REFERENCES clientes(id),
    nome TEXT NOT NULL,
    endereco TEXT,
    cidade TEXT,
    estado TEXT,
    num_unidades INTEGER,
    vgv_estimado REAL,
    status TEXT DEFAULT 'prospecto',
    data_lancamento TEXT,
    data_inicio_vendas TEXT,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS corretores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf TEXT,
    creci TEXT,
    telefone TEXT,
    email TEXT,
    imobiliaria TEXT,
    cidade TEXT,
    estado TEXT,
    aniversario TEXT,
    foto_url TEXT,
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    telefone TEXT,
    email TEXT,
    cidade TEXT,
    objetivo TEXT,
    faixa_investimento TEXT,
    prazo TEXT,
    empreendimento_interesse TEXT,
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    corretor_id INTEGER REFERENCES corretores(id),
    status TEXT DEFAULT 'novo',
    origem TEXT DEFAULT 'whatsapp',
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    corretor_id INTEGER REFERENCES corretores(id),
    cliente_id INTEGER REFERENCES clientes(id),
    imovel TEXT,
    valor REAL NOT NULL,
    data_venda TEXT NOT NULL,
    status TEXT DEFAULT 'ativo',
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS financeiro_entradas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    venda_id INTEGER REFERENCES vendas(id),
    descricao TEXT NOT NULL,
    tipo TEXT NOT NULL,
    valor REAL NOT NULL,
    data_prevista TEXT,
    data_recebimento TEXT,
    status TEXT DEFAULT 'pendente',
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS financeiro_saidas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    descricao TEXT NOT NULL,
    categoria TEXT NOT NULL,
    valor REAL NOT NULL,
    data_pagamento TEXT,
    status TEXT DEFAULT 'pendente',
    recorrente INTEGER DEFAULT 0,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS distribuicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    data TEXT NOT NULL,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lancamentos_calendario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    titulo TEXT NOT NULL,
    data TEXT NOT NULL,
    tipo TEXT DEFAULT 'lancamento',
    descricao TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS unidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER NOT NULL REFERENCES empreendimentos(id) ON DELETE CASCADE,
    quadra TEXT,
    lote TEXT NOT NULL,
    area_m2 REAL,
    preco REAL,
    status TEXT DEFAULT 'disponivel',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations: adiciona colunas que podem estar faltando em bancos antigos
const migrations = [
  "ALTER TABLE leads ADD COLUMN aniversario TEXT",
  "ALTER TABLE leads ADD COLUMN cpf TEXT",
  "ALTER TABLE clientes ADD COLUMN aniversario TEXT",
  "ALTER TABLE empreendimentos ADD COLUMN percentual_r2x REAL",
  "ALTER TABLE vendas ADD COLUMN unidade_id INTEGER REFERENCES unidades(id)",
  "ALTER TABLE vendas ADD COLUMN percentual_r2x REAL",
  "ALTER TABLE vendas ADD COLUMN comissao_r2x REAL",
  "ALTER TABLE financeiro_entradas ADD COLUMN parcela_num INTEGER",
  "ALTER TABLE financeiro_entradas ADD COLUMN parcela_total INTEGER",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* coluna já existe */ }
}

// ─── GESTÃO PESSOAL ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pf_contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    banco TEXT,
    titular TEXT DEFAULT 'Ramon',
    tipo TEXT DEFAULT 'corrente',
    saldo_inicial REAL DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_transacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_id INTEGER REFERENCES pf_contas(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    tipo TEXT DEFAULT 'saida',
    categoria TEXT,
    origem TEXT DEFAULT 'manual',
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_cartoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    bandeira TEXT,
    limite REAL,
    dia_fechamento INTEGER,
    dia_vencimento INTEGER,
    titular TEXT DEFAULT 'Ramon',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_lancamentos_cartao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cartao_id INTEGER REFERENCES pf_cartoes(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    descricao TEXT NOT NULL,
    valor REAL NOT NULL,
    categoria TEXT,
    parcela_num INTEGER,
    parcela_total INTEGER,
    mes_fatura TEXT,
    origem TEXT DEFAULT 'manual',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_contas_fixas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    valor REAL NOT NULL,
    dia_vencimento INTEGER,
    categoria TEXT DEFAULT 'casa',
    ativa INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_pagamentos_fixos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_fixa_id INTEGER REFERENCES pf_contas_fixas(id) ON DELETE CASCADE,
    mes_ano TEXT NOT NULL,
    pago INTEGER DEFAULT 0,
    data_pagamento TEXT,
    valor REAL,
    observacoes TEXT,
    UNIQUE(conta_fixa_id, mes_ano)
  );

  CREATE TABLE IF NOT EXISTS pf_fontes_renda (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    tipo TEXT DEFAULT 'empresa',
    descricao TEXT,
    titular TEXT DEFAULT 'Ramon',
    ativa INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pf_entradas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fonte_id INTEGER REFERENCES pf_fontes_renda(id),
    data TEXT NOT NULL,
    valor REAL NOT NULL,
    descricao TEXT,
    recebido INTEGER DEFAULT 1,
    titular TEXT DEFAULT 'Ramon',
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
