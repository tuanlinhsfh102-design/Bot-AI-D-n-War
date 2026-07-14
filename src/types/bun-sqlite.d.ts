declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { create?: boolean });
    run(sql: string, params?: any[] | Record<string, any>): void;
    query<T = any>(sql: string): { run: (...params: any[]) => T };
    close(): void;
  }
}
