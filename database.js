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
  "ALTER TABLE usuarios ADD COLUMN cliente_id INTEGER REFERENCES clientes(id)",
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
  "ALTER TABLE vendas ADD COLUMN valor_entrada REAL",
  "ALTER TABLE vendas ADD COLUMN entrada_parcelas TEXT",
  "ALTER TABLE vendas ADD COLUMN percentual_r2x_override REAL",
  "ALTER TABLE financeiro_entradas ADD COLUMN tem_nf_propria INTEGER DEFAULT 1",
  "ALTER TABLE financeiro_entradas ADD COLUMN nf_numero TEXT",
  "ALTER TABLE financeiro_entradas ADD COLUMN nf_data TEXT",
  "ALTER TABLE vendas ADD COLUMN comissao_corretor_data_pagamento TEXT",
  "ALTER TABLE vendas ADD COLUMN comissao_corretor_valor_pago REAL DEFAULT 0",
  "ALTER TABLE vendas ADD COLUMN vaga_id INTEGER REFERENCES vagas_garagem(id)",
  "ALTER TABLE leads ADD COLUMN creci TEXT",
  "ALTER TABLE leads ADD COLUMN imobiliaria TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* coluna já existe */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS vagas_garagem (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empreendimento_id INTEGER NOT NULL REFERENCES empreendimentos(id) ON DELETE CASCADE,
    numero TEXT NOT NULL,
    bloco TEXT,
    tipo TEXT DEFAULT 'coberta',
    preco REAL,
    status TEXT DEFAULT 'disponivel',
    venda_id INTEGER REFERENCES vendas(id),
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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

// Configuração financeira do corretor (split de imobiliária etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS corretor_config (
    corretor_id INTEGER PRIMARY KEY REFERENCES corretores(id) ON DELETE CASCADE,
    imobiliaria_nome TEXT,
    imobiliaria_split_pct REAL DEFAULT 0
  );
`);

// Despesas do corretor
db.exec(`
  CREATE TABLE IF NOT EXISTS corretor_despesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corretor_id INTEGER NOT NULL REFERENCES corretores(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL,
    categoria TEXT DEFAULT 'outros',
    valor REAL NOT NULL,
    data_pagamento TEXT,
    recorrente INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pago',
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Agenda de tarefas do corretor
db.exec(`
  CREATE TABLE IF NOT EXISTS corretor_tarefas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corretor_id INTEGER NOT NULL REFERENCES corretores(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL,
    tipo TEXT DEFAULT 'ligacao',
    cliente_nome TEXT,
    data_tarefa TEXT,
    hora TEXT,
    concluida INTEGER DEFAULT 0,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Metas mensais do corretor
db.exec(`
  CREATE TABLE IF NOT EXISTS corretor_metas_mensais (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corretor_id INTEGER NOT NULL REFERENCES corretores(id) ON DELETE CASCADE,
    mes INTEGER NOT NULL,
    ano INTEGER NOT NULL,
    meta_vgv REAL DEFAULT 0,
    meta_qtd INTEGER DEFAULT 0,
    meta_comissao REAL DEFAULT 0,
    UNIQUE(corretor_id, mes, ano)
  );
`);

// Tabela de clientes próprios do corretor (acesso privado por corretor)
db.exec(`
  CREATE TABLE IF NOT EXISTS corretor_clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corretor_id INTEGER NOT NULL REFERENCES corretores(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    cpf TEXT,
    telefone TEXT,
    email TEXT,
    cidade TEXT,
    estado TEXT,
    aniversario TEXT,
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

// Eventos de lançamento e checklists
db.exec(`
  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    data TEXT NOT NULL,
    hora TEXT,
    local TEXT,
    empreendimento_id INTEGER REFERENCES empreendimentos(id),
    descricao TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS evento_checklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
    fase TEXT NOT NULL DEFAULT 'pre',
    categoria TEXT,
    texto TEXT NOT NULL,
    sub_texto TEXT,
    responsavel TEXT,
    observacoes TEXT,
    concluido INTEGER DEFAULT 0,
    ordem INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS imposto_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    iss_pct REAL DEFAULT 3.0,
    pis_pct REAL DEFAULT 0.65,
    cofins_pct REAL DEFAULT 3.0,
    irpj_base_presumida_pct REAL DEFAULT 32.0,
    csll_base_presumida_pct REAL DEFAULT 32.0,
    municipio TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS imposto_apuracao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo TEXT NOT NULL,
    tipo TEXT NOT NULL,
    receita_base REAL NOT NULL DEFAULT 0,
    aliquota REAL NOT NULL DEFAULT 0,
    valor REAL NOT NULL DEFAULT 0,
    adicional_irpj REAL DEFAULT 0,
    vencimento TEXT,
    status TEXT DEFAULT 'pendente',
    data_pagamento TEXT,
    saida_id INTEGER REFERENCES financeiro_saidas(id),
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT OR IGNORE INTO imposto_config (id) VALUES (1);
`);

// ─── GESTÃO PESSOAL ───────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS pessoal_receitas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao TEXT NOT NULL,
    categoria TEXT DEFAULT 'outros',
    valor REAL NOT NULL,
    data TEXT NOT NULL,
    recorrente INTEGER DEFAULT 0,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pessoal_despesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao TEXT NOT NULL,
    categoria TEXT DEFAULT 'outros',
    valor REAL NOT NULL,
    data TEXT NOT NULL,
    recorrente INTEGER DEFAULT 0,
    observacoes TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pessoal_metas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    categoria TEXT DEFAULT 'financeira',
    valor_meta REAL DEFAULT 0,
    valor_atual REAL DEFAULT 0,
    prazo TEXT,
    status TEXT DEFAULT 'em_andamento',
    descricao TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pessoal_tarefas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    categoria TEXT DEFAULT 'pessoal',
    prioridade TEXT DEFAULT 'media',
    prazo TEXT,
    concluida INTEGER DEFAULT 0,
    descricao TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pessoal_habitos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    icone TEXT DEFAULT '✅',
    frequencia TEXT DEFAULT 'diario',
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pessoal_habitos_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habito_id INTEGER NOT NULL REFERENCES pessoal_habitos(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    concluido INTEGER DEFAULT 1,
    UNIQUE(habito_id, data)
  );
`);

module.exports = db;
