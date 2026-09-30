import { afterEach, expect, it } from 'vitest';
import { requestConfirmation, resolveDialog, showMessage, useDialogStore } from './dialogStore';

afterEach(() => {
  useDialogStore.getState().requests.forEach(request => resolveDialog(request.id, false));
});

it('keeps a later error visible without replacing a pending confirmation', async () => {
  const answer = requestConfirmation({ title: 'Delete song?', message: 'Delete Northern Sky?', actionLabel: 'Delete song' });
  showMessage('Could not save', 'Please try again.');
  const [confirmation, error] = useDialogStore.getState().requests;
  expect(confirmation.confirmation).toBe(true);
  resolveDialog(confirmation.id, false);
  expect(await answer).toBe(false);
  expect(useDialogStore.getState().requests).toEqual([error]);
  // A repeated close event must not dismiss the next message.
  resolveDialog(confirmation.id, true);
  expect(useDialogStore.getState().requests).toEqual([error]);
  resolveDialog(error.id, true);
  expect(useDialogStore.getState().requests).toEqual([]);
});

it('resolves only the explicitly accepted confirmation', async () => {
  const accepted = requestConfirmation({ title: 'Replace queue?', message: 'Replace Kitchen?', actionLabel: 'Replace queue' });
  const cancelled = requestConfirmation({ title: 'Delete playlist?', message: 'Delete Housewarming?', actionLabel: 'Delete playlist' });
  const [first, second] = useDialogStore.getState().requests;
  resolveDialog(first.id, true);
  resolveDialog(second.id, false);
  expect(await accepted).toBe(true);
  expect(await cancelled).toBe(false);
});
