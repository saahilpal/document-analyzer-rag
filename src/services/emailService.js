const nodemailer = require('nodemailer');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  APP_NAME: ENV_APP_NAME,
} = process.env;

const APP_NAME = ENV_APP_NAME || 'DocAnalyzer';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST || 'smtp.mailtrap.io',
  port: Number(SMTP_PORT) || 2525,
  auth: {
    user: SMTP_USER || 'user',
    pass: SMTP_PASS || 'pass',
  },
});

function renderEmailTemplate(title, bodyHtml) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f9fafb; margin: 0; padding: 40px 20px; color: #1f2937; }
        .container { max-width: 500px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
        .header { padding: 24px 32px; border-bottom: 1px solid #f3f4f6; text-align: center; }
        .header h2 { margin: 0; font-size: 20px; font-weight: 600; color: #111827; }
        .content { padding: 32px; font-size: 15px; line-height: 1.6; color: #4b5563; }
        .code-block { background-color: #f3f4f6; padding: 16px; text-align: center; border-radius: 6px; margin: 24px 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 24px; font-weight: 700; letter-spacing: 4px; color: #111827; }
        .footer { padding: 24px 32px; background-color: #f9fafb; border-top: 1px solid #f3f4f6; text-align: center; font-size: 13px; color: #6b7280; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>${title}</h2>
        </div>
        <div class="content">
          ${bodyHtml}
        </div>
        <div class="footer">
          ${APP_NAME} &mdash; Ask your documents anything.
        </div>
      </div>
    </body>
    </html>
    `;
}

async function sendEmail(type, data) {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }

  let subject = '';
  let html = '';
  const to = data.to;

  switch (type) {
    case 'verify':
      subject = 'Account Verification - Action Required';
      html = renderEmailTemplate('Account Verification', `
                <p>You are receiving this email to verify your account registration. Enter the following code to continue:</p>
                <div class="code-block">${data.otp}</div>
                <p>This code expires in 5 minutes. If you did not sign up for ${APP_NAME}, please ignore this message.</p>
            `);
      break;
    case 'welcome':
      subject = `Welcome to ${APP_NAME}`;
      html = renderEmailTemplate('Welcome to ' + APP_NAME, `
                <p>Hello,</p>
                <p>Your account has been verified successfully. Welcome to ${APP_NAME}.</p>
                <p>${APP_NAME} allows users to upload documents and ask questions, receiving answers derived directly from document content using context-based AI retrieval.</p>
                <p>To get started, simply upload a document to your workspace to ask your first question.</p>
                <p>Best regards,<br>The ${APP_NAME} Team</p>
            `);
      break;
    case 'reset':
      subject = 'Password Reset Request';
      html = renderEmailTemplate('Password Reset', `
                <p>We received a request to reset your password. Use the secure token below to confirm the reset:</p>
                <div class="code-block" style="font-size: 16px; letter-spacing: normal; word-break: break-all;">${data.token}</div>
                <p>This token is valid for 15 minutes. If you did not request a password reset, you can safely ignore this email.</p>
            `);
      break;
    case 'reset-success':
      subject = 'Password Successfully Changed';
      html = renderEmailTemplate('Password Reset Successful', `
                <p>Your password has been successfully updated.</p>
                <p>If you did not make this change, please contact support immediately to secure your account.</p>
                <p>You can now safely log in with your new password.</p>
            `);
      break;
    case 'email-change':
      subject = 'Confirm Your New Email Address';
      html = renderEmailTemplate('Verify New Email', `
                <p>We received a request to link this email address to your account. Please confirm by entering the following code:</p>
                <div class="code-block">${data.otp}</div>
                <p>This code expires in 5 minutes. If you did not authorize this change, please contact support immediately.</p>
            `);
      break;
    case 'alert':
      subject = 'Security Alert: New Login Detected';
      html = renderEmailTemplate('Security Alert', `
                <p>We detected a new login to your account from an unrecognized device.</p>
                <div style="background-color: #f9fafb; padding: 16px; border-radius: 6px; margin: 24px 0; border: 1px solid #e5e7eb;">
                  <div style="margin-bottom: 8px;"><strong>IP Address:</strong> ${data.ip || 'Unknown IP Address'}</div>
                  <div><strong>Device:</strong> ${data.device || 'Unknown Device'}</div>
                </div>
                <p>If this was you, no further action is required. If you do not recognize this activity, please reset your password immediately.</p>
            `);
      break;
    default:
      throw new Error(`Unknown template type: ${type}`);
  }

  const mailOptions = {
    from: SMTP_FROM || `"${APP_NAME} Security" <noreply@docanalyzer.local>`,
    to,
    subject,
    html,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (error) {
    console.error('[EmailService] Failed to send email:', error);
    throw error;
  }
}

module.exports = {
  sendEmail
};
