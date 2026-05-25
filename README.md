# Searvator CRM v2.0

Multi-vertical business management system — Hardware Service, AI Software, CCTV & Biometric, Other Business — sab ek hi jagah.

## Features

### 🔧 Hardware & Repair (existing - preserved)
- Service entries with PC component status tracking
- Hardware orders with vendor pricing & profit
- Agent assignments & WhatsApp tracking

### 🤖 AI Software Projects
- Project tracking with client info & quoted price
- **One-time costs** (server setup, API charges, dev time, tools, misc)
- **Recurring monthly costs** (AWS, OpenAI subscriptions, etc.)
- **Revenue tracking** (advances, milestones, monthly fees)
- Live Net P&L calculation with margin %

### 📹 CCTV & Biometric
- Product catalog (Camera, DVR/NVR, Cable, Biometric, etc.)
- Quotation builder — pick products from catalog, auto-calculate GST
- Professional branded **PDF quotation** download
- Quotation status tracking (Draft / Sent / Approved / Rejected)

### 📋 Other Business
- Flexible work tracker for misc/side projects
- Revenue, expenses, profit tracking

---

## Setup Instructions

### 1. Install Dependencies

```bash
cd sea-crm
npm install
```

### 2. Create `.env` File

Copy `.env.example` to `.env` and update:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/searvator
SESSION_SECRET=your_secret_key_here
```

**Important:** Same MongoDB use kar rahe hain. Existing collections (`entries`, `orders`, `targets`) preserved hain. Naye collections jo banenge: `aiprojects`, `cctvproducts`, `quotations`, `otherbusinesses`.

### 3. Start Server

```bash
npm start
```

Or with auto-restart on changes:
```bash
npm run dev
```

Open: **http://localhost:3000**

### 4. Demo Login Credentials

| Role  | Username | Password   |
|-------|----------|------------|
| Admin | `admin`  | `admin123` |
| Agent | `agent1` | `agent123` |
| Agent | `agent2` | `agent123` |

**Production me ye change karein** — `server.js` me `USERS` object update kariye.

---

## Project Structure

```
sea-crm/
├── server.js                  # Main Express server with all routes
├── package.json
├── .env                       # Environment variables (create from .env.example)
├── models/
│   ├── Entry.js               # Hardware service entries (existing)
│   ├── Order.js               # Hardware orders (existing)
│   ├── Target.js              # Sales targets (existing)
│   ├── AIProject.js           # AI projects with costs/revenue
│   ├── CCTVProduct.js         # Product catalog
│   ├── Quotation.js           # Quotations with items
│   └── OtherBusiness.js       # Misc work tracker
├── views/
│   ├── login.ejs
│   ├── admin.ejs              # Main admin dashboard
│   ├── agent.ejs              # Agent panel
│   ├── ai-projects.ejs        # AI projects list
│   ├── ai-project-detail.ejs  # AI project P&L tracker
│   ├── cctv.ejs               # CCTV catalog + quotations list
│   ├── quotation-builder.ejs  # Interactive quotation builder
│   ├── other-business.ejs     # Other business tracker
│   └── partials/sidebar.ejs   # Shared sidebar
├── public/
│   ├── css/main.css           # All styles
│   └── js/common.js           # Common JS helpers
└── uploads/                   # File uploads folder
```

---

## How to Use

### Adding a CCTV Quotation (typical workflow)

1. Pehle **CCTV → Product Catalog** tab me products add karo (jaise "2MP Bullet Camera", "8 Channel DVR", "Coaxial Cable", etc.) — saath me selling price & GST.
2. **+ New Quotation** click karo.
3. Right side se products pick karo, ya custom item add karo.
4. Quantity, price, GST adjust karo — totals auto-calculate hote hain.
5. **Save** karo, phir **📄 Preview PDF** click karke download/print karo.

### Tracking an AI Project P&L

1. **AI Software → + New Project** — client info & quoted price daalo.
2. Project detail page kholo (project pe click karo).
3. **Costs** tab: server, API, dev time — sab one-time costs daalte raho.
4. **Recurring** tab: monthly server/API subscription cost daalo.
5. **Revenue** tab: jab bhi client se payment aaye, add karo.
6. Top par live Net Profit + Margin % dikhega.

---

## Database Migration Note

Aapka existing data **safe hai** — ye system aapke existing MongoDB ke saath compatible hai:

- ✅ `entries` collection — schema same, existing data load hoga
- ✅ `orders` collection — schema same, existing data load hoga
- ✅ `targets` collection — schema same

Naye collections (jo MongoDB automatic banayega):
- `aiprojects` (AI software projects)
- `cctvproducts` (Product catalog)
- `quotations` (Quotations)
- `otherbusinesses` (Misc work)

Existing data me koi loss nahi hoga.

---

## Tech Stack

- **Backend:** Node.js, Express 4
- **Database:** MongoDB (Mongoose 8)
- **View:** EJS templates
- **PDF:** PDFKit
- **Auth:** Express-session (hardcoded users)
- **Styling:** Custom CSS (white modern UI, Plus Jakarta Sans font)

---

## Customization

### Change brand name/colors
- `views/partials/sidebar.ejs` — brand name & logo
- `public/css/main.css` — `:root` me color variables

### Add more users
- `server.js` → `USERS` object

### Default targets
- `server.js` → Target route

---

Built with ❤️ for Searvator
