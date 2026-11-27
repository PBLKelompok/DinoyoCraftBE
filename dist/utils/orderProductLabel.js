"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrderProductSummary = getOrderProductSummary;
const database_js_1 = __importDefault(require("../config/database.js"));
async function getOrderProductSummary(orderId, queryable = database_js_1.default) {
    try {
        const [rows] = await queryable.query(`SELECT p.name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`, [Number(orderId)]);
        if (Array.isArray(rows) && rows.length > 0) {
            const firstName = String(rows[0]?.name || '').trim();
            if (firstName) {
                return rows.length > 1
                    ? `${firstName} (+${rows.length - 1} produk lainnya)`
                    : firstName;
            }
        }
    }
    catch {
        // Fallback jika query gagal
    }
    return 'Pesanan Keramik Anda';
}
//# sourceMappingURL=orderProductLabel.js.map