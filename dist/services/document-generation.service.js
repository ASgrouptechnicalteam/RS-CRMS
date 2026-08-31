"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentGenerationService = void 0;
const document_service_1 = require("./document.service");
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
let browserInstance = null;
async function getBrowserInstance() {
    if (browserInstance)
        return browserInstance;
    // Dynamically import puppeteer to bypass Jest CommonJS export token errors
    // since tests do not invoke generation and puppeteer v22+ is ESM.
    const { default: puppeteer } = await Promise.resolve().then(() => __importStar(require('puppeteer')));
    browserInstance = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    return browserInstance;
}
class DocumentGenerationService {
    static async generatePdfFromHtml(html) {
        const browser = await getBrowserInstance();
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        // Convert to PDF
        const pdfUint8Array = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
        });
        await page.close();
        return Buffer.from(pdfUint8Array);
    }
    static async generateAndUploadDocument(user, html, filename, data) {
        const pdfBuffer = await this.generatePdfFromHtml(html);
        const file = {
            fieldname: 'file',
            originalname: filename,
            encoding: '7bit',
            mimetype: 'application/pdf',
            size: pdfBuffer.length,
            buffer: pdfBuffer,
        };
        return document_service_1.DocumentService.uploadDocument(user, file, data);
    }
    static async generateReceipt(user, paymentId) {
        const payment = await prisma.payment.findFirst({
            where: { id: paymentId, company_id: user.companyId },
            include: {
                booking: {
                    include: {
                        customer: true,
                        property: true,
                    }
                }
            }
        });
        if (!payment) {
            throw { status: 404, message: 'Payment not found' };
        }
        const customer = payment.booking.customer;
        const property = payment.booking.property;
        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: 'Helvetica', 'Arial', sans-serif; padding: 40px; color: #333; }
          .header { text-align: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
          .title { font-size: 24px; font-weight: bold; text-transform: uppercase; letter-spacing: 2px; }
          .receipt-details { display: flex; justify-content: space-between; margin-bottom: 40px; }
          .info-block { width: 45%; }
          .info-block h3 { margin-top: 0; color: #555; font-size: 14px; text-transform: uppercase; border-bottom: 1px solid #eee; padding-bottom: 5px; }
          .info-block p { margin: 5px 0; font-size: 14px; }
          .amount-box { background: #f9f9f9; border: 1px solid #ddd; padding: 20px; text-align: center; margin-bottom: 40px; }
          .amount { font-size: 32px; font-weight: bold; color: #2c3e50; }
          .footer { text-align: center; font-size: 12px; color: #888; margin-top: 50px; border-top: 1px solid #eee; padding-top: 20px; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
          th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
          th { background-color: #f9f9f9; color: #555; text-transform: uppercase; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">Official Receipt</div>
          <p>Receipt #: ${payment.payment_code}</p>
        </div>
        
        <div class="receipt-details">
          <div class="info-block">
            <h3>Received From</h3>
            <p><strong>${customer.first_name} ${customer.last_name}</strong></p>
            <p>${customer.phone}</p>
            <p>Customer ID: ${customer.customer_code}</p>
          </div>
          <div class="info-block">
            <h3>Payment Details</h3>
            <p><strong>Date:</strong> ${payment.payment_date.toDateString()}</p>
            <p><strong>Method:</strong> ${payment.payment_method}</p>
            ${payment.reference_number ? `<p><strong>Reference:</strong> ${payment.reference_number}</p>` : ''}
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Booking Ref</th>
              <th style="text-align: right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Payment towards Property ${property.property_code}</td>
              <td>${payment.booking.booking_code}</td>
              <td style="text-align: right; font-weight: bold;">₹${payment.amount.toLocaleString('en-IN')}</td>
            </tr>
          </tbody>
        </table>

        <div class="amount-box">
          <p style="margin-top: 0; color: #666; text-transform: uppercase; font-size: 14px;">Total Amount Received</p>
          <div class="amount">₹${payment.amount.toLocaleString('en-IN')}</div>
        </div>

        <div class="footer">
          <p>This is a computer generated receipt and does not require a physical signature.</p>
        </div>
      </body>
      </html>
    `;
        return this.generateAndUploadDocument(user, html, `Receipt_${payment.payment_code}.pdf`, {
            document_type: 'PAYMENT_RECEIPT',
            title: `Payment Receipt - ${payment.payment_code}`,
            customer_id: customer.id,
            booking_id: payment.booking_id,
            payment_id: payment.id,
        });
    }
    static async generateAgreement(user, bookingId) {
        const booking = await prisma.booking.findFirst({
            where: { id: bookingId, company_id: user.companyId },
            include: {
                customer: true,
                property: {
                    include: {
                        project: true,
                    }
                }
            }
        });
        if (!booking) {
            throw { status: 404, message: 'Booking not found' };
        }
        const customer = booking.customer;
        const property = booking.property;
        const project = property.project;
        const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: 'Times New Roman', serif; padding: 60px; color: #000; line-height: 1.6; }
          .title { text-align: center; font-size: 24px; font-weight: bold; margin-bottom: 40px; text-decoration: underline; }
          .section { margin-bottom: 20px; }
          .party-details { display: flex; justify-content: space-between; margin-bottom: 30px; }
          .party { width: 45%; }
          .party h3 { text-decoration: underline; }
          .signature-block { margin-top: 80px; display: flex; justify-content: space-between; }
          .sign-line { border-top: 1px solid #000; width: 200px; margin-top: 50px; padding-top: 10px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="title">AGREEMENT OF SALE</div>
        
        <div class="section">
          <p>This Agreement of Sale ("Agreement") is made and entered into on this <strong>${new Date().toLocaleDateString()}</strong>, by and between:</p>
        </div>

        <div class="party-details">
          <div class="party">
            <h3>THE VENDOR</h3>
            <p><strong>RRH EMS</strong><br>
            Hyderabad, Telangana<br>
            (Hereinafter referred to as the "Builder/Vendor")</p>
          </div>
          <div class="party">
            <h3>THE VENDEE</h3>
            <p><strong>${customer.first_name} ${customer.last_name}</strong><br>
            Phone: ${customer.phone}<br>
            (Hereinafter referred to as the "Purchaser")</p>
          </div>
        </div>

        <div class="section">
          <p><strong>WHEREAS</strong> the Builder is developing the project known as <strong>${project?.name || ''}</strong> located at <strong>${project?.location || ''}</strong>.</p>
          <p><strong>AND WHEREAS</strong> the Purchaser has agreed to purchase the property described below for a total sale consideration of <strong>₹${booking.agreed_price.toLocaleString('en-IN')}</strong>.</p>
        </div>

        <div class="section">
          <h3>PROPERTY SCHEDULE</h3>
          <p>All that piece and parcel of <strong>${property.category}</strong> bearing Code <strong>${property.property_code}</strong>, measuring <strong>${property.area_sqft}</strong> sq.ft., situated at <strong>${property.location}</strong> in the project <strong>${project?.name || ''}</strong>.</p>
        </div>

        <div class="section">
          <h3>TERMS AND CONDITIONS</h3>
          <ol>
            <li>The Purchaser shall pay the balance amount as per the payment schedule.</li>
            <li>Possession of the property will be handed over upon full realization of the total sale consideration.</li>
            <li>Registration charges, stamp duty, and other statutory taxes shall be borne by the Purchaser.</li>
          </ol>
        </div>

        <div class="signature-block">
          <div>
            <div class="sign-line">Signature of Vendor</div>
          </div>
          <div>
            <div class="sign-line">Signature of Purchaser</div>
          </div>
        </div>
      </body>
      </html>
    `;
        return this.generateAndUploadDocument(user, html, `Agreement_${booking.booking_code}.pdf`, {
            document_type: 'LEGAL_AGREEMENT',
            title: `Sale Agreement - ${booking.booking_code}`,
            customer_id: customer.id,
            booking_id: booking.id,
            property_id: property.id,
            project_id: project?.id,
        });
    }
    // Gracefully close browser instance on shutdown
    static async closeBrowser() {
        if (browserInstance) {
            await browserInstance.close();
            browserInstance = null;
        }
    }
}
exports.DocumentGenerationService = DocumentGenerationService;
