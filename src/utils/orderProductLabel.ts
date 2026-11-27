import db from '../config/database.js';

export async function getOrderProductSummary(
  orderId: number | string,
  queryable: { query: (sql: string, params?: any[]) => Promise<any> } = db
): Promise<string> {
  try {
    const [rows]: any = await queryable.query(
      `SELECT p.name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`,
      [Number(orderId)]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      const firstName = String(rows[0]?.name || '').trim();
      if (firstName) {
        return rows.length > 1
          ? `${firstName} (+${rows.length - 1} produk lainnya)`
          : firstName;
      }
    }
  } catch {
    // Fallback jika query gagal
  }
  return 'Pesanan Keramik Anda';
}
