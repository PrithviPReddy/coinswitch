# CoinSwitch – Crypto Swap Web Application

CoinSwitch is a full-stack web application that demonstrates a simplified cryptocurrency token swap workflow, built using modern web technologies.
This project was developed as a personal portfolio project to showcase frontend, backend, and API integration skills.

# 🚀 Features

Token listing and selection

Real-time quote fetching

Token swap execution flow

Authentication using NextAuth

Modular UI components

API routes using Next.js App Router

TypeScript-based codebase

# 🧱 Tech Stack

## Frontend

Next.js (App Router)

React

TypeScript

CSS / Tailwind (if applicable)

## Backend

Next.js API Routes

NextAuth for authentication

## Tooling

ESLint

TypeScript

Node.js

# 📂 Project Structure

```plaintext
app/
├── api/ # Backend API routes
├── components/ # Reusable UI components
├── auth/ # Authentication logic
├── page.tsx # Main application entry
└── layout.tsx # App layout
config/
├── prisma.config.ts
└── eslint / tsconfig
```

# 🔁 Application Flow

User authenticates using NextAuth

User selects a source and destination token

Application fetches a quote via API

Swap request is processed via backend route

Result is returned and displayed to the user

# 🔐 Authentication

Authentication is handled using NextAuth, providing a secure and extensible authentication layer.
Protected routes can be extended to enforce authorization for sensitive operations such as swaps.

# ⚙️ Setup Instructions

## 1. Clone the repository

```bash
git clone https://github.com/PrithviPReddy/coinswitch.git

cd coinswitch
```

## 2. Install dependencies

```bash
npm install
```

## 3. Configure environment variables

Create a .env file and add the required values:

```env
NEXTAUTH_SECRET=your_secret_here
NEXTAUTH_URL=http://localhost:3000

```

## 4. Run the development server

```bash
npm run dev
```

Open http://localhost:3000
 in your browser.

# 🧪 Current Limitations

Minimal input validation

No rate limiting on APIs

No caching for quotes

Limited UI error handling

These are intentional trade-offs for an MVP-level personal project.

# 📈 Future Improvements

Add schema validation using Zod

Introduce caching for token and quote APIs

Improve UI error and loading states

Add unit and integration tests

Improve documentation and architecture layering

# 🎓 Academic Context

This project was built by a 3rd-year Computer Science student as a personal resume project to demonstrate:

Real-world framework usage

Full-stack understanding

Clean and maintainable code practices

# 📜 License

This project is intended for educational and portfolio purposes.
