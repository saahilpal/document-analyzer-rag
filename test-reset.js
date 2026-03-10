const authService = require('./src/services/authService');
const db = require('./src/config/database');

async function testReset() {
    const email = 'test-reset@example.com';

    // Clean up if exists
    db.prepare(`DELETE FROM users WHERE email = ?`).run(email);

    console.log('1. Creating user...');
    const user = await authService.createUser({
        name: 'Test Reset User',
        email,
        password: 'password123'
    });

    if (!user) {
        console.log('Failed to create user');
        return;
    }
    console.log('User created:', user.id);

    console.log('2. Requesting password reset...');
    await authService.requestPasswordReset(email);

    console.log('3. Checking the database for the reset OTP...');
    const row = db.prepare(`SELECT * FROM password_reset_otps WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(user.id);

    if (row) {
        console.log('RESET RECORD FOUND!');
        console.log('OTP Hash length:', row.otp_hash.length);
        console.log('Is it a bcrypt hash? (starts with $2a$ or $2b$):', row.otp_hash.startsWith('$2'));
    } else {
        console.log('NO RESET RECORD FOUND in password_reset_otps.');
    }
}

testReset().catch(console.error);
