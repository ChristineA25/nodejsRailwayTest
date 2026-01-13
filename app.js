
const express = require('express');
const path = require('path');
const crypto = require('crypto'); // for encryption
const mysql = require('mysql2/promise'); // MySQL connection
const indexRouter = require('./routes/index');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json()); // parse JSON bodies
app.use(express.static(path.join(__dirname, 'public')));
app.use('/', indexRouter);

// MySQL connection pool
const pool = mysql.createPool({
    host: 'YOUR_MYSQL_HOST',
    user: 'YOUR_MYSQL_USER',
    password: 'YOUR_MYSQL_PASSWORD',
    database: 'YOUR_DATABASE',
});

// Signup route
app.post('/signup', async (req, res) => {
    try {
        const { identifier, password, questions, answers } = req.body;

        // Generate encrypted userID from current time + identifier
        const rawString = `${Date.now()}-${identifier}`;
        const userID = crypto.createHash('sha256').update(rawString).digest('hex');

        // Insert into MySQL
        const sql = `INSERT INTO users (userID, identifier, password, q1, a1, q2, a2, q3, a3)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await pool.execute(sql, [
            userID,
            identifier,
            password,
            questions[0],
            answers[0],
            questions[1],
            answers[1],
            questions[2],
            answers[2],
        ]);

        res.json({ success: true, userID });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 404 handler
app.use((req, res, next) => {
    res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
