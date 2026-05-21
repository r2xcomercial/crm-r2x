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

db.exec(`
  CREATE TABLE IF NOT EXISTS metas_corretores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corretor_id INTEGER NOT NULL REFERENCES corretores(id) ON DELETE CASCADE,
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    mes INTEGER NOT NULL,
    ano INTEGER NOT NULL,
    meta_qtd INTEGER DEFAULT 0,
    meta_vgv REAL DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// SQLite não aceita expressões em UNIQUE dentro de CREATE TABLE; usamos index separado
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_metas_unique
    ON metas_corretores(corretor_id, COALESCE(empreendimento_id, 0), mes, ano);`);
} catch (_) { /* índice já existe */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL DEFAULT 'ligacao',
    descricao TEXT,
    data_retorno TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations: adiciona colunas que podem estar faltando em bancos antigos
const migrations = [
  "ALTER TABLE leads ADD COLUMN aniversario TEXT",
  "ALTER TABLE leads ADD COLUMN cpf TEXT",
  "ALTER TABLE leads ADD COLUMN tipo TEXT",
  "ALTER TABLE leads ADD COLUMN score INTEGER DEFAULT 0",
  "ALTER TABLE leads ADD COLUMN resumo TEXT",
  "ALTER TABLE clientes ADD COLUMN aniversario TEXT",
  "ALTER TABLE empreendimentos ADD COLUMN percentual_r2x REAL",
  "ALTER TABLE vendas ADD COLUMN unidade_id INTEGER REFERENCES unidades(id)",
  "ALTER TABLE vendas ADD COLUMN percentual_r2x REAL",
  "ALTER TABLE vendas ADD COLUMN comissao_r2x REAL",
  "ALTER TABLE financeiro_entradas ADD COLUMN parcela_num INTEGER",
  "ALTER TABLE financeiro_entradas ADD COLUMN parcela_total INTEGER",
  "ALTER TABLE empreendimentos ADD COLUMN tipo TEXT DEFAULT 'loteamento'",
  "ALTER TABLE vendas ADD COLUMN comissao_corretor_pct REAL",
  "ALTER TABLE vendas ADD COLUMN comissao_corretor_valor REAL",
  "ALTER TABLE vendas ADD COLUMN comissao_corretor_status TEXT DEFAULT 'pendente'",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* coluna já existe */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS mapas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER NOT NULL UNIQUE REFERENCES empreendimentos(id) ON DELETE CASCADE,
    svg_data TEXT NOT NULL,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS checklist_marketing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER NOT NULL REFERENCES empreendimentos(id) ON DELETE CASCADE,
    material TEXT NOT NULL,
    responsavel TEXT,
    data_entrega TEXT,
    status TEXT DEFAULT 'a_definir',
    ordem INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    perfil TEXT DEFAULT 'corretor',
    corretor_id INTEGER REFERENCES corretores(id),
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TEXT NOT NULL,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS interacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    tipo TEXT DEFAULT 'nota',
    descricao TEXT NOT NULL,
    usuario_nome TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS visitas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    corretor_id INTEGER REFERENCES corretores(id),
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    data_visita TEXT NOT NULL,
    unidade_interesse TEXT,
    proximo_passo TEXT,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Tabela de vendas próprias do corretor (externas à R2X)
db.exec(`
  CREATE TABLE IF NOT EXISTS corretor_vendas_proprias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corretor_id INTEGER NOT NULL REFERENCES corretores(id) ON DELETE CASCADE,
    data_venda TEXT NOT NULL,
    empreendimento TEXT,
    imovel TEXT,
    cliente_nome TEXT,
    valor_venda REAL DEFAULT 0,
    comissao_pct REAL,
    comissao_valor REAL,
    status_comissao TEXT DEFAULT 'pendente',
    valor_recebido REAL DEFAULT 0,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
