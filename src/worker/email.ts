import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

// SOL_PRIVATE_KEY=""
// SMTP_USERNAME=""
// SMTP_PASSWORD=""
// SMTP_ENDPOINT

const transport = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USERNAME,
    pass: process.env.SMTP_PASSWORD,
  },
});

export async function sendEmail(to: string, body: string) {
  await transport.sendMail({
    from: process.env.SMTP_USERNAME,
    //sender: "contact@100xdevs.com",
    to,
    subject: "Hello from Zapier",
    text: body,
  });
}
