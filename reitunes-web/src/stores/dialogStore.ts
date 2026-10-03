import { create } from 'zustand';

interface DialogOptions {
  title: string;
  message: string;
  actionLabel: string;
  destructive?: boolean;
  details?: string[];
}

interface DialogRequest extends DialogOptions {
  id: number;
  confirmation: boolean;
  resolve: (accepted: boolean) => void;
}

let nextId = 0;
export const useDialogStore = create<{ requests: DialogRequest[] }>(() => ({ requests: [] }));

function enqueue(options: DialogOptions, confirmation: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const request = { ...options, confirmation, resolve, id: ++nextId };
    useDialogStore.setState(state => ({ requests: [...state.requests, request] }));
  });
}

export function requestConfirmation(options: DialogOptions): Promise<boolean> {
  return enqueue(options, true);
}

export function showMessage(title: string, message: string): void {
  void enqueue({ title, message, actionLabel: 'Close' }, false);
}

export function resolveDialog(id: number, accepted: boolean): void {
  const request = useDialogStore.getState().requests.find(request => request.id === id);
  if (!request) return;
  useDialogStore.setState(state => ({ requests: state.requests.filter(request => request.id !== id) }));
  request.resolve(accepted);
}
