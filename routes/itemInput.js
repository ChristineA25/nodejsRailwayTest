
// routes/itemInput.js (ESM)

import express from "express";
import { pool } from "../db.js";
import crypto from "crypto";

const router = express.Router();


router.post("/", async (req, res) => {
  try {
    const {
      userID,
      brand,
      itemName,
      itemID,
      itemNo,
      feature,
      quantity,
      itemCount,
      priceValue,
      priceID,
      discountApplied,
      channel,
      shop_name,
      shop_address,
      chainShopID
    } = req.body || {};

    if (!userID)   return res.status(400).json({ error: "userID_required" });
    if (!itemName) return res.status(400).json({ error: "itemName_required" });
    if (priceValue == null || priceValue === '') {
      return res.status(400).json({ error: "price_required" });
    }

    // Normalize
    const normChannel = (channel ?? '').toString().trim().toLowerCase();
    const chanFinal = (normChannel === 'online' || normChannel === 'physical')
      ? normChannel
      : null; // let DB accept NULL if column is nullable, or reject clearly below

    // Tinyint(1) friendly boolean
    const discFinal =
      typeof discountApplied === 'boolean'
        ? (discountApplied ? 1 : 0)
        : (discountApplied == null ? null : (String(discountApplied).toLowerCase() === 'true' ? 1 : 0));

    if (!chanFinal) {
      // If your DB has NOT NULL/ENUM for channel, fail early with a clear message
      return res.status(400).json({ error: "channel_must_be_online_or_physical" });
    }

    const sql = `
      INSERT INTO itemInput
      (userID, brand, itemName, itemID, itemNo, feature,
       quantity, itemNo, priceValue, priceID, discountApplied,
       channel, shop_name, shop_address, chainShopID, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.execute(sql, [
      String(userID),
      brand ?? null,
      String(itemName),
      itemID ?? null,
      itemNo ?? null,
      feature ?? null,
      quantity ?? null,
      (itemCount == null || itemCount === '') ? 1 : Number(itemCount),
      Number(priceValue),
      priceID ?? crypto.randomUUID(),
      discFinal,                    // 0/1/null
      chanFinal,                    // 'online' | 'physical'
      shop_name ?? null,
      shop_address ?? null,
      chainShopID ?? crypto.randomUUID(),
      new Date()
    ]);

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /api/itemInput error:", err);
    // Expose cause for now; lock down in production if needed.
    res.status(500).json({
      error: "server_error",
      code: err?.code,
      errno: err?.errno,
      sqlState: err?.sqlState,
      sqlMessage: err?.sqlMessage
    });
  }
});


export default router;
