/**
 * Amazon Order Matcher
 *
 * Matches Lunch Money Amazon transactions to Amazon order history
 * using date proximity and amount matching. Tries single items first,
 * then full orders, then pair/triple subset sums.
 */
import fs from 'fs';
import path from 'path';

const DB_DIR = path.join(process.cwd(), 'db');
const AMAZON_FILE = path.join(DB_DIR, 'amazon-orders.json');

interface AmazonItem {
  date: string;
  order_date: string;
  amount: number;
  name: string;
  order_id: string;
  qty: number;
}

interface AmazonOrder {
  date: string;
  order_date: string;
  amount: number;
  items: { name: string; qty: number; amount: number }[];
  order_id: string;
}

interface AmazonRefund {
  date: string | null;
  amount: number;
  order_id: string;
  products: string[];
}

interface AmazonData {
  items: AmazonItem[];
  orders: AmazonOrder[];
  refunds: AmazonRefund[];
}

export interface AmazonMatch {
  products: string[];
  order_id?: string;
  match_type: 'item' | 'order' | 'pair' | 'triple' | 'refund';
}

let cachedData: AmazonData | null = null;
let cachedMtime = 0;

function loadAmazonData(): AmazonData | null {
  try {
    const stat = fs.statSync(AMAZON_FILE);
    if (cachedData && stat.mtimeMs === cachedMtime) return cachedData;
    cachedData = JSON.parse(fs.readFileSync(AMAZON_FILE, 'utf-8'));
    cachedMtime = stat.mtimeMs;
    return cachedData;
  } catch {
    return null;
  }
}

function daysDiff(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

/**
 * Match a single transaction to Amazon orders.
 * @param txDate - YYYY-MM-DD
 * @param txAmount - positive = charge, negative = refund
 */
export function matchTransaction(
  txDate: string,
  txAmount: number,
): AmazonMatch | null {
  const data = loadAmazonData();
  if (!data) return null;

  const amt = Math.abs(txAmount);
  const isRefund = txAmount < 0;
  const tolerance = 0.05;

  if (isRefund) {
    // Match refunds
    for (const r of data.refunds) {
      if (!r.date) continue;
      if (
        Math.abs(daysDiff(txDate, r.date)) <= 5 &&
        Math.abs(r.amount - amt) < tolerance
      ) {
        return {
          products:
            r.products.length > 0 ? r.products : ['(refund - product unknown)'],
          order_id: r.order_id,
          match_type: 'refund',
        };
      }
    }
    return null;
  }

  // 1) Exact single item match (±5 days on ship or order date)
  for (const item of data.items) {
    if (Math.abs(item.amount - amt) < tolerance) {
      if (
        Math.abs(daysDiff(txDate, item.date)) <= 5 ||
        Math.abs(daysDiff(txDate, item.order_date)) <= 5
      ) {
        return {
          products: [item.name],
          order_id: item.order_id,
          match_type: 'item',
        };
      }
    }
  }

  // 2) Full order match (±5 days)
  for (const order of data.orders) {
    if (Math.abs(order.amount - amt) < tolerance) {
      if (
        Math.abs(daysDiff(txDate, order.date)) <= 5 ||
        Math.abs(daysDiff(txDate, order.order_date)) <= 5
      ) {
        return {
          products: order.items.map((i) => i.name),
          order_id: order.order_id,
          match_type: 'order',
        };
      }
    }
  }

  // 3) Subset sum — pairs and triples within ±7 days
  const nearby = data.items.filter(
    (ic) =>
      Math.abs(daysDiff(txDate, ic.date)) <= 7 ||
      Math.abs(daysDiff(txDate, ic.order_date)) <= 7,
  );

  for (let i = 0; i < nearby.length; i++) {
    for (let j = i + 1; j < nearby.length; j++) {
      const sum2 = nearby[i].amount + nearby[j].amount;
      if (Math.abs(sum2 - amt) < tolerance) {
        return {
          products: [nearby[i].name, nearby[j].name],
          match_type: 'pair',
        };
      }
      for (let k = j + 1; k < Math.min(nearby.length, j + 30); k++) {
        if (Math.abs(sum2 + nearby[k].amount - amt) < tolerance) {
          return {
            products: [nearby[i].name, nearby[j].name, nearby[k].name],
            match_type: 'triple',
          };
        }
      }
    }
  }

  return null;
}

/**
 * Batch match: given an array of transactions, return a map of tx_id -> match.
 */
export function matchTransactions(
  transactions: {
    id: number;
    date: string;
    amount: string;
    payee?: string;
    original_name?: string;
  }[],
): Record<number, AmazonMatch> {
  const results: Record<number, AmazonMatch> = {};

  for (const tx of transactions) {
    const name = (tx.payee || tx.original_name || '').toLowerCase();
    if (!name.includes('amazon')) continue;
    const match = matchTransaction(tx.date, parseFloat(tx.amount));
    if (match) {
      results[tx.id] = match;
    }
  }

  return results;
}

export function hasAmazonData(): boolean {
  return fs.existsSync(AMAZON_FILE);
}
