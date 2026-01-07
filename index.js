
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';

const app = express();
app.use(cors());
app.use(express.json());

// Connect to Railway MySQL using environment variables
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT
});

// Simple test route
app.get('/', (req, res) => res.send('API is running'));

// Insert data into "testing" table
app.post('/add', async (req, res) => {
  const { testing } = req.body;
  if (!testing) return res.status(400).json({ error: 'testing is required' });

  try {
    const [result] = await pool.query('INSERT INTO testing (testing) VALUES (?)', [testing]);
    res.json({ id: result.insertId, testing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));
