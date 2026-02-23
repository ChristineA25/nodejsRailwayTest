
// routes/itemInput.js
const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const crypto = require("crypto"); // NEW for generating UUIDs

// POST /api/itemInput
router.post("/", async (req, res) => {
  try {
    const {
      userID,
      brand,
      itemName,
      itemID,
      itemNo,               // NEW
      feature,
      quantity,
      itemCount,
      priceValue,
      priceID,             // NEW
      discountApplied,     // NEW
      channel,
      shop_name,
      shop_address,
      chainShopID          // NEW
    } = req.body || {};

    if (!userID) return res.status(400).json({ error: "userID_required" });
    if (!itemName) return res.status(400).json({ error: "itemName_required" });
    if (!priceValue) return res.status(400).json({ error: "price_required" });

    // 🔥 NEW SQL with all required DB columns
    const sql = `
      INSERT INTO itemInput
      (userID, brand, itemName, itemID, itemNo, feature,
       quantity, itemCount, priceValue, priceID, discountApplied,
       channel, shop_name, shop_address, chainShopID, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // 🔥 NEW VALUES ARRAY matching your DB columns exactly
    await pool.execute(sql, [
      userID,
      brand ?? null,
      itemName,
      itemID ?? null,
      itemNo ?? null,
      feature ?? null,
      quantity ?? null,
      itemCount ?? 1,
      priceValue,
      priceID ?? crypto.randomUUID(),     // NEW
      discountApplied ?? null,            // NEW
      channel,
      shop_name ?? null,
      shop_address ?? null,
      chainShopID ?? crypto.randomUUID(), // NEW
      new Date()                          // createdAt
    ]);

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("POST /api/itemInput error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

module.exports = router;
