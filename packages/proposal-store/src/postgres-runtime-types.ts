export type PostgresRuntimeQueryResult = {
  rows: Record<string, unknown>[];
};

export type PostgresRuntimeClient = {
  query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult>;
  release(): void;
};

export type PostgresRuntimePool = {
  connect(): Promise<PostgresRuntimeClient>;
  query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult>;
  end?(): Promise<void>;
};
