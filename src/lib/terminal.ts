import { invoke } from "@tauri-apps/api/core";

export interface TerminalSession { id: string; shell: string; cwd: string }
export interface TerminalOutput { data: number[]; exited: boolean; exit_code: number | null; error: string | null }

export interface TerminalTransport {
  open(cols: number, rows: number): Promise<TerminalSession>;
  poll(id: string): Promise<TerminalOutput>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
}

export const desktopTerminal: TerminalTransport = {
  open: (cols, rows) => invoke("terminal_open", { cols, rows }),
  poll: (id) => invoke("terminal_poll", { id }),
  write: (id, data) => invoke("terminal_write", { id, data }),
  resize: (id, cols, rows) => invoke("terminal_resize", { id, cols, rows }),
  close: (id) => invoke("terminal_close", { id }),
};
