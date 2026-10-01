export const withdrawalReceiptKey = 'quiz-relay-withdrawal';

export function readWithdrawalReceipt(subject?: string): {
  id: string;
  subject: string;
} | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(withdrawalReceiptKey) ?? 'null');
    return saved &&
      typeof saved.id === 'string' &&
      typeof saved.subject === 'string' &&
      (!subject || saved.subject === subject)
      ? saved
      : null;
  } catch {
    return null;
  }
}
