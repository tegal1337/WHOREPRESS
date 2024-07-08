export interface LogEntry {
    type: 'HIT' | 'BAD';
    url: string;
    username: string;
    password: string;
}

export interface IWordpress {
    hits: number;
    bad: number;
    cpm: number;
    start: number;
    logBuffer: LogEntry[];
    displayUI(): void;
    updateTitle(): Promise<void>;
    calculateCpm(): Promise<void>;
    checkAccount(url: string, username: string, password: string): Promise<void>;
}