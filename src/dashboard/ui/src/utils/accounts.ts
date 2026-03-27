export function normType(t: string | undefined): string {
  if (!t) return 'other';
  t = t.toLowerCase();
  if (t.includes('depository') || t === 'cash') return 'cash';
  if (t.includes('credit')) return 'credit';
  if (t.includes('investment') || t.includes('brokerage')) return 'investment';
  if (t.includes('loan') || t.includes('mortgage')) return 'loan';
  return 'other';
}

export function calcTax(
  salary: number,
  brackets: { upTo: number; rate: number }[],
): number {
  if (!brackets || !brackets.length) return 0;
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    if (salary <= prev) break;
    const taxable = Math.min(salary, b.upTo) - prev;
    tax += (taxable * b.rate) / 100;
    prev = b.upTo;
  }
  const lastBracket = brackets[brackets.length - 1];
  if (salary > lastBracket.upTo) {
    tax += ((salary - lastBracket.upTo) * lastBracket.rate) / 100;
  }
  return tax;
}
