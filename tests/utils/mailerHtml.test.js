'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NAME IN A MAIL IS TEXT
//
//  The sign-in code and password-reset mails greet the person by the
//  name typed on the Users screen, and put it into the mail's HTML as it
//  was: markup in a name became markup in a mail carrying the company's
//  name and a sign-in link. A name is text.
//
//  Found reading utils/mailer.js line by line.
// ══════════════════════════════════════════════════════════════════

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'm1' });
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: (...a) => mockSendMail(...a) }) }));

process.env.SMTP_HOST = 'smtp.test';
process.env.SMTP_USER = 'no-reply@test';
process.env.SMTP_PASS = 'x';

const mailer = require('../../utils/mailer');
const NAME = '<a href="https://evil.example">Click</a> Kumar';

beforeEach(() => mockSendMail.mockClear());

describe('a mail that greets a person', () => {
  it('shows their name as it was typed, never as markup — the sign-in code', async () => {
    await mailer.sendLoginOtpEmail({ to: 'k@t.co', name: NAME, code: '482913', ttlMinutes: 10 });
    const { html, text } = mockSendMail.mock.calls[0][0];
    expect(html).not.toMatch(/<a href="https:\/\/evil/);
    expect(html).toMatch(/Hi &lt;a,/);
    expect(html).toMatch(/482913/);
    expect(text).toMatch(/^Hi <a,/);          // plain text is plain text
  });

  it('and the password reset, whose link still works', async () => {
    const resetUrl = 'https://erp.example/reset?token=abc&id=1';
    await mailer.sendPasswordResetEmail({ to: 'k@t.co', name: '<img src=x onerror=alert(1)>', resetUrl, ttlMinutes: 30 });
    const { html, text } = mockSendMail.mock.calls[0][0];
    expect(html).not.toMatch(/<img/);
    expect(html).toMatch(/href="https:\/\/erp\.example\/reset\?token=abc&amp;id=1"/);
    expect(text).toContain(resetUrl);
  });

  it('greets someone with no name, or an ordinary one, as before', async () => {
    await mailer.sendLoginOtpEmail({ to: 'k@t.co', name: '', code: '111222', ttlMinutes: 10 });
    await mailer.sendLoginOtpEmail({ to: 'k@t.co', name: 'Selvi  Raman', code: '111222', ttlMinutes: 10 });
    expect(mockSendMail.mock.calls[0][0].html).toMatch(/Hi there,/);
    expect(mockSendMail.mock.calls[1][0].html).toMatch(/Hi Selvi,/);
    expect(mockSendMail.mock.calls[1][0].text).toMatch(/^Hi Selvi,/);
  });
});
