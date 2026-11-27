// Legal pages for Diamondz Tokenize: Privacy Policy, Terms of Use, Risk Disclosures.
//
// DRAFTS written 2026-11-18 from what the platform actually does (see the code paths named in comments). They are
// not legal advice and must be reviewed by counsel before anyone relies on them. When the platform changes how it
// handles data, fees or offerings, update the matching section here AND `UPDATED` below.
//
// Text tokens filled in at render time: {{EMAIL}} (the legal contact from the API, LEGAL_CONTACT_EMAIL), {{SITE}}
// (the brand name of the site being viewed).

export const COMPANY = "Shadow Diamondz Development, Inc.";
export const UPDATED = "November 18, 2026";

export type Block = string | { list: string[] } | { note: string };
export interface Section { id: string; title: string; body: Block[] }
export interface LegalDoc { slug: "privacy" | "terms" | "risk"; title: string; summary: string; sections: Section[] }

const privacy: LegalDoc = {
  slug: "privacy",
  title: "Privacy Policy",
  summary: "What personal information Diamondz Tokenize collects, why, who we share it with, how long we keep it, and the choices you have.",
  sections: [
    {
      id: "who",
      title: "Who we are",
      body: [
        `Diamondz Tokenize is software operated by ${COMPANY}, a Delaware corporation ("Diamondz", "we", "us"). It lets companies ("issuers") create, offer and manage tokenized securities, and lets investors verify themselves and invest in those offerings.`,
        "This policy covers tokenize.diamondz.one and the investor sites issuers run on Diamondz Tokenize under their own name and domain (\"white-label sites\").",
        "When you invest in or ask about a specific offering, the issuer of that offering decides what it needs to know about you and why. For that information we act on the issuer's behalf, as its service provider, and the issuer's own privacy notice also applies. For everything else in this policy, such as our own website, contact form and issuer accounts, Diamondz is responsible for your information.",
      ],
    },
    {
      id: "collect",
      title: "What we collect",
      body: [
        "We collect only what the platform needs to work and to meet legal requirements:",
        { list: [
          "Contact form. Your name, email address, company (optional) and message, plus the IP address the message came from. We use the IP address to stop spam and abuse.",
          "Issuer accounts. When someone from an issuer signs in to the console with Google, we receive their name and email address from Google. Sign-in is limited to the issuer's approved company domains.",
          "Wallet addresses. The public blockchain address you connect or create to invest. If you create a wallet with an email or social login, that login is handled by thirdweb, our wallet provider; we never receive your password or your wallet's private key.",
          "Sanctions screening. We check wallet addresses against the U.S. Treasury's OFAC sanctions list and an on-chain sanctions screening service before they can buy or receive a token.",
          "Accredited-investor checks. If an offering is open only to accredited investors, you can link your bank or brokerage accounts through Mastercard Open Finance, with your written consent. Mastercard prepares an income or asset report for the issuer. We keep Mastercard's reference numbers for your request, the consent you gave and when, and a numbers-only summary of the report. We do not receive or store your bank login, and we do not store the full report or your statements.",
          "Identity and company verification. Offerings may require you to verify your identity (\"KYC\") and issuers to verify their company and its owners (\"KYB\") through Sumsub, our verification provider. Sumsub collects your ID document, a selfie and a short liveness video, and checks them; for companies it collects registration documents and details of owners and directors. We receive the result and Sumsub's reference number, not copies of your documents or your face images.",
          "Issuer business accounts. To confirm that an asset's income was really received, an issuer can link its own business bank account through Mastercard. We keep the account's label, the expected amount, the expected payers' names and the monthly result.",
          "Offering records. Details issuers enter about their offerings and the payouts they send to token holders, including the wallet addresses paid and the amounts.",
          "Evidence files. Documents that approved independent verifiers upload to support an offering's checks, such as an appraisal or a reserve report. These are published on purpose so investors can inspect them; verifiers are asked not to include personal information.",
          "Technical information. Like most websites, our servers and our network provider (Cloudflare) receive your IP address, browser type and the pages you request, and keep short-lived logs for security and troubleshooting.",
        ] },
        "We do not use advertising trackers, analytics cookies or tracking pixels.",
      ],
    },
    {
      id: "blockchain",
      title: "Blockchain records are public and permanent",
      body: [
        "Tokens, purchases, transfers and payouts are recorded on public blockchains. Anyone can see the wallet addresses and amounts involved, and these records cannot be changed or deleted by us, by the issuer or by anyone else. We never write your name, email address or identity documents to a blockchain. Whether a wallet is approved to hold an offering's token is recorded on chain, and so are fingerprints (hashes) of verifiers' evidence files.",
      ],
    },
    {
      id: "use",
      title: "How we use it",
      body: [
        { list: [
          "To run the platform: sign issuers in, show offerings, process purchases and send payouts.",
          "To help issuers meet their legal duties, such as checking that investors are eligible, screening against sanctions lists and keeping records.",
          "To answer messages you send us, and to alert the issuer's team when you contact them.",
          "To keep the platform secure, prevent fraud and abuse, and fix problems.",
          "To comply with law, legal process and regulators' requests, and to protect our rights and the rights of others.",
        ] },
        "We do not sell your personal information and we do not share it for cross-context behavioral advertising. We do not use it to make automated decisions with legal effect about you; issuers decide whether to accept an investor, and an issuer can review the verification results before deciding.",
        "If you are in the European Economic Area or the UK, our legal bases are: performing a contract with you or taking steps you asked for; our legitimate interests in running a secure platform and answering inquiries; compliance with legal obligations; and your consent where we ask for it (for example, for Mastercard reports). Where Sumsub processes biometric data to verify your identity, it does so with your explicit consent, which you give in the verification flow.",
      ],
    },
    {
      id: "share",
      title: "Who we share it with",
      body: [
        "We share personal information only as needed to provide the service:",
        { list: [
          "The issuer of the offering you invest in or contact, which receives your verification results, accreditation report, wallet address and messages.",
          "Service providers that process information for us under contract: Google Cloud (servers), MongoDB Atlas (database), Cloudflare (network and security), Mastercard Open Finance (bank-account reports), Sumsub (identity and company verification), thirdweb (wallets and payments), Temporal (scheduled background jobs) and Resend (email alerts).",
          "Google, when you sign in with Google, and when your browser loads the fonts this site uses from Google's servers.",
          "Authorities, courts and regulators when the law requires it, or when needed to protect people, property or the platform.",
          "A buyer or successor if Diamondz is involved in a merger, acquisition or sale of assets, subject to this policy.",
        ] },
        "Public information we show, such as an issuer's SEC Form D filing, comes from the SEC's public EDGAR database.",
      ],
    },
    {
      id: "where",
      title: "Where your information is stored",
      body: [
        "Our servers and database are hosted by Google Cloud and MongoDB Atlas in the European Union (Netherlands and Western Europe). Diamondz is a U.S. company, and some of our service providers operate in the United States and other countries, so your information may be accessed from or transferred to those places. Where the law requires it, we use appropriate safeguards for these transfers, such as the European Commission's Standard Contractual Clauses.",
      ],
    },
    {
      id: "keep",
      title: "How long we keep it",
      body: [
        { list: [
          "Console sign-in sessions end after 12 hours.",
          "Contact-form messages stay in the recipient's inbox until they delete them, and we delete them at your request unless we need to keep them.",
          "Verification, accreditation, sanctions-screening and transaction records are kept as long as the issuer needs them for its offering and its legal record-keeping duties, which for securities and anti-money-laundering records is often at least five years after the relationship ends.",
          "Server logs are kept for a short period for security, usually no more than 90 days.",
          "Blockchain records are permanent and outside our control.",
        ] },
        { note: "[COUNSEL: confirm retention periods; the platform does not yet delete contact messages or records automatically.]" },
      ],
    },
    {
      id: "rights",
      title: "Your choices and rights",
      body: [
        "Depending on where you live, you may have the right to ask for a copy of your personal information, to correct it, to delete it, to receive it in a portable format, to object to or restrict some uses, and to withdraw consent you gave. California residents have the right to know, delete and correct personal information and not to be discriminated against for using these rights; we do not sell or share personal information as those terms are defined in California law.",
        "To make a request, email {{EMAIL}}. We will confirm who you are before acting, and answer within the time the law requires (usually 30 to 45 days). If your request is about an offering, we may pass it to the issuer, which decides. Some information cannot be deleted, such as blockchain records, or must be kept to meet legal duties.",
        "If you are in the EEA or the UK, you can also complain to your local data protection authority.",
      ],
    },
    {
      id: "security",
      title: "Security",
      body: [
        "We protect information with encryption in transit, access limited to the people who need it, signed sessions, and separate data for each issuer. Identity documents and bank credentials stay with Sumsub and Mastercard and never reach our servers. No system is perfectly secure; if a breach affects your information, we will notify you and regulators as the law requires.",
      ],
    },
    {
      id: "cookies",
      title: "Cookies and local storage",
      body: [
        "We use one cookie, which keeps an issuer signed in to the console; it expires after 12 hours. The site also keeps a few settings in your browser's local storage, such as a half-finished form or whether you have seen the console tour, so they survive a page reload. Wallet software you use may store its own data in your browser. If you install the site as an app, your device also keeps copies of the site's own files (code, icons and logos) so it opens faster; these contain no personal information. We do not use cookies for advertising or analytics.",
      ],
    },
    {
      id: "children",
      title: "Children",
      body: ["Diamondz Tokenize is not for anyone under 18, and we do not knowingly collect information from children."],
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: ["We will post any changes on this page and update the date at the top. If a change is significant, we will give notice on the site or by email before it takes effect."],
    },
    {
      id: "contact",
      title: "Contact",
      body: [`${COMPANY}. Email {{EMAIL}} with any question about this policy or your information.`, { note: "[COUNSEL/OWNER: add a mailing address for privacy requests.]" }],
    },
  ],
};

const terms: LegalDoc = {
  slug: "terms",
  title: "Terms of Use",
  summary: "The rules for using Diamondz Tokenize, what the platform is and isn't, and the responsibilities of issuers and investors.",
  sections: [
    {
      id: "agreement",
      title: "Agreement",
      body: [
        `These Terms of Use ("Terms") are an agreement between you and ${COMPANY}, a Delaware corporation ("Diamondz", "we", "us"), and govern your use of Diamondz Tokenize, including tokenize.diamondz.one, the issuer console, and investor sites that issuers run on our software (together, the "Platform"). By using the Platform you agree to these Terms and to our Privacy Policy. If you use the Platform for a company, you confirm you can bind that company to these Terms.`,
        "Issuers who subscribe to a paid plan may also sign an order form or subscription agreement with us. If it conflicts with these Terms, that agreement controls.",
      ],
    },
    {
      id: "what",
      title: "What the Platform is, and what it isn't",
      body: [
        "Diamondz Tokenize is software. It helps issuers create blockchain tokens that represent interests in their assets, run their own offerings, verify investors and pay income to token holders.",
        "Diamondz is not a broker-dealer, funding portal, exchange, alternative trading system, transfer agent, investment adviser, bank or custodian. We do not offer or sell securities, recommend investments, negotiate terms, hold investors' money or tokens, or receive any payment based on the amount an issuer raises. Every offering on the Platform is made by its issuer, under the issuer's own legal exemption and its own offering documents. Secondary trading of tokens, where permitted, happens only through licensed third parties.",
        "Nothing on the Platform is investment, legal, tax or accounting advice.",
      ],
    },
    {
      id: "eligibility",
      title: "Who can use it",
      body: [
        "You must be at least 18 and able to form a binding contract. You may not use the Platform if you are on a U.S. or other applicable sanctions list, are located in a sanctioned country or region, or are barred by law from doing so. Each offering sets its own investor requirements, for example that investors be accredited investors or not be U.S. persons, and you may invest only if you meet them.",
      ],
    },
    {
      id: "issuers",
      title: "Issuers' responsibilities",
      body: [
        "If you use the Platform to issue tokens, you are solely responsible for your offering, including:",
        { list: [
          "deciding whether your tokens are securities and complying with all securities laws that apply, including choosing and meeting the conditions of an exemption (for example Rule 506(c) of Regulation D) and making any filings, such as Form D and state notice filings;",
          "the accuracy and completeness of everything you publish about your offering and asset, and providing investors with proper offering documents;",
          "verifying investors' identity, eligibility and accredited status, screening them for sanctions and anti-money-laundering purposes, and keeping the records the law requires, using the Platform's tools or your own;",
          "your own taxes and your investors' tax reporting;",
          "the smart contracts you deploy, the networks and settings you choose, the wallets and keys that control them, and any upgrades you make;",
          "any income you promise to token holders, and paying it.",
        ] },
        "You should have a qualified securities lawyer review your offering before you sell to anyone. You authorize us to show your listing, offering details and public filings to visitors, and you confirm you have the right to everything you upload.",
      ],
    },
    {
      id: "investors",
      title: "Investors' responsibilities",
      body: [
        "Before investing, read the issuer's offering documents and our Risk Disclosures, and get your own professional advice. You are responsible for the accuracy of what you tell the issuer and our verification providers, for keeping your wallet and its keys safe, and for any network fees. Blockchain transactions are final: we cannot reverse a purchase, a transfer or a payment sent to a wrong address. Tokens can usually be held and transferred only by approved wallets, and may be locked up or restricted by law or by the offering's terms.",
      ],
    },
    {
      id: "demo",
      title: "Demo listings",
      body: [
        "Listings marked \"Demo\" run on test networks. Their tokens and stablecoins are test assets with no value; nothing in a demo listing is offered for sale.",
      ],
    },
    {
      id: "fees",
      title: "Fees",
      body: [
        "Issuers pay the subscription, setup and per-offering fees of their plan, as shown on our pricing page or in their order form. Our fees are never a percentage of the money an issuer raises. When an issuer sends income to token holders through the Platform, a distribution fee may apply, as shown in the console before the payout is sent. Network fees (\"gas\") are paid to the blockchain, not to us. Fees are non-refundable except where the law or your order form says otherwise.",
      ],
    },
    {
      id: "third",
      title: "Third-party services",
      body: [
        "The Platform relies on services we do not control, including blockchains, wallet providers (thirdweb), Mastercard Open Finance, Sumsub, Circle (USDC), Chainlink, the SEC's EDGAR system and others. Their own terms apply to your use of them, and we are not responsible for their availability, accuracy or actions. Mentioning a company or technology does not mean it endorses or partners with us.",
      ],
    },
    {
      id: "use",
      title: "Acceptable use",
      body: [
        "You agree not to: break any law or help anyone else do so; launder money, finance terrorism or evade sanctions; publish false or misleading information about an offering; impersonate anyone; upload malware or anything you have no right to share; try to get into accounts, data or systems you are not authorized to access; overload, scrape or interfere with the Platform; or use it to build a competing product.",
      ],
    },
    {
      id: "accounts",
      title: "Accounts and suspension",
      body: [
        "Keep your sign-in secure and tell us right away about any unauthorized use. We may suspend or end access to the Platform, remove a listing, or refuse a transaction if we reasonably believe it is needed to comply with law, protect investors or the Platform, or because these Terms were broken. Tokens already on a blockchain remain there and stay controlled by the contracts and wallets that hold them.",
      ],
    },
    {
      id: "ip",
      title: "Intellectual property",
      body: [
        "We own the Platform, its software, design and the Diamondz names and logos. We give you a limited, revocable, non-transferable right to use the Platform under these Terms. Issuers keep ownership of their content and grant us a license to host and display it to run the Platform. If you send us feedback, we may use it without obligation to you. Open-source components are licensed under their own terms.",
      ],
    },
    {
      id: "disclaimer",
      title: "Disclaimers",
      body: [
        "THE PLATFORM IS PROVIDED \"AS IS\" AND \"AS AVAILABLE\". TO THE FULLEST EXTENT THE LAW ALLOWS, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. WE DO NOT PROMISE THAT THE PLATFORM, ANY SMART CONTRACT, ANY BLOCKCHAIN OR ANY THIRD-PARTY SERVICE WILL BE UNINTERRUPTED, SECURE OR ERROR-FREE, OR THAT ANY OFFERING, ASSET, VERIFICATION OR INCOME IS WHAT IT IS DESCRIBED TO BE. Independent checks shown on a listing are performed by third parties and are not audits, appraisals or guarantees by Diamondz.",
      ],
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: [
        "TO THE FULLEST EXTENT THE LAW ALLOWS, DIAMONDZ AND ITS OFFICERS, EMPLOYEES AND SUPPLIERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, INVESTMENT LOSSES, LOST DATA OR LOST DIGITAL ASSETS, ARISING FROM YOUR USE OF THE PLATFORM, EVEN IF WE WERE TOLD THEY WERE POSSIBLE. OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE PLATFORM IS LIMITED TO THE GREATER OF THE FEES YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM AND US$100. Some places do not allow these limits, so they may not fully apply to you.",
      ],
    },
    {
      id: "indemnity",
      title: "Indemnity",
      body: [
        "You will defend and compensate Diamondz for claims, losses and costs (including reasonable legal fees) that arise from your breach of these Terms or of the law, from your content, or, if you are an issuer, from your offering.",
      ],
    },
    {
      id: "law",
      title: "Governing law and disputes",
      body: [
        "These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-laws rules, and by the U.S. federal securities laws where they apply. Any dispute will be resolved exclusively in the state or federal courts located in Delaware, and you and we consent to their jurisdiction. Nothing here limits rights you have under laws that cannot be waived by contract.",
        { note: "[COUNSEL: decide whether to add binding arbitration and a class-action waiver.]" },
      ],
    },
    {
      id: "changes",
      title: "Changes and general terms",
      body: [
        "We may update these Terms by posting a new version here with a new date; significant changes will be announced in advance on the site or by email. If you keep using the Platform after a change takes effect, you accept it. If any part of these Terms is unenforceable, the rest stays in effect. Not enforcing a right is not a waiver of it. You may not transfer these Terms without our consent; we may transfer them in a merger or sale of our business. These Terms, the Privacy Policy and any order form are the entire agreement between us about the Platform.",
      ],
    },
    {
      id: "contact",
      title: "Contact",
      body: [`${COMPANY}. Email {{EMAIL}}.`, { note: "[COUNSEL/OWNER: add a mailing address for legal notices.]" }],
    },
  ],
};

const risk: LegalDoc = {
  slug: "risk",
  title: "Risk Disclosures",
  summary: "The main risks of buying tokenized securities through Diamondz Tokenize. Read them, and the issuer's own offering documents, before you invest.",
  sections: [
    {
      id: "general",
      title: "Read this before you invest",
      body: [
        `Tokenized securities are speculative and risky. You could lose all the money you invest. This page describes general risks; it is not a complete list, and every offering has its own risks, described in its issuer's offering documents. ${COMPANY} ("Diamondz") provides software only: it does not offer or recommend any investment, review offerings for merit, or guarantee anything an issuer says. Invest only money you can afford to lose, and get independent legal, tax and financial advice.`,
      ],
    },
    {
      id: "investment",
      title: "Investment risks",
      body: [
        { list: [
          "Loss of capital. The asset may lose value, earn less than expected or fail completely. Past results and projected income are not guarantees.",
          "Illiquidity. There may be no way to sell your tokens for a long time, or ever. Offerings may have lockup periods, and securities bought in private offerings are usually \"restricted securities\" that cannot be resold freely. Any secondary market, where available, is run by third parties and may be thin or close.",
          "Income is not guaranteed. Payouts depend on the asset actually earning money and on the issuer choosing and being able to pay. Payout amounts and timing can change or stop.",
          "Issuer risk. You depend on the issuer and its managers to run the asset well, to be honest and to keep its promises. Issuers may be new companies with limited history, may have conflicts of interest, and may fail.",
          "Valuation. Token prices are set by the issuer and may not reflect what the asset is worth or what anyone would pay for it.",
          "Limited rights. A token may give you economic rights only, without a vote, information rights or a direct claim on the asset. Your rights are only those in the offering documents and the law.",
          "Concentration. Each offering is usually tied to one asset or a small group of assets.",
        ] },
      ],
    },
    {
      id: "legal",
      title: "Legal and regulatory risks",
      body: [
        { list: [
          "Offerings on the Platform are generally made under exemptions from registration, such as Rule 506(c) of Regulation D. The SEC and state regulators do not review or approve these offerings, and you do not receive the protections of a registered offering. A Form D filing is a notice, not an approval.",
          "Laws and regulators' views on tokenized securities, stablecoins and blockchains are changing and may change in ways that hurt the value or usability of your tokens, or force an offering or the Platform to change or stop.",
          "Transfers may be blocked to comply with law, for example if a wallet appears on a sanctions list, or if the buyer is not eligible.",
          "Tax rules for tokenized assets are complex and may change. You are responsible for your own taxes.",
        ] },
      ],
    },
    {
      id: "technology",
      title: "Technology risks",
      body: [
        { list: [
          "Smart contracts may contain errors or be exploited, which could cause tokens or funds to be lost or frozen. Contracts can be upgraded by whoever controls them, usually the issuer.",
          "Blockchains can slow down, halt, split, change their rules or become very expensive to use. Network fees are paid by you and can change quickly.",
          "Transactions are final. Payments sent to a wrong address, or approved by mistake, generally cannot be reversed.",
          "You are responsible for your wallet. If you lose access to it, or someone else gets its keys, your tokens may be lost or stolen and no one may be able to recover them. Be wary of phishing: we will never ask for your keys or recovery phrase.",
          "Stablecoins used for purchases and payouts, such as USDC or USDG, can lose their peg, be frozen by their issuers, or become unavailable.",
          "Some features depend on oracles and outside services (for example price feeds, sanctions lists, bank-data providers and verification providers), which can be wrong, late or unavailable.",
        ] },
      ],
    },
    {
      id: "proof",
      title: "Limits of independent checks",
      body: [
        "Listings may show checks by independent verifiers, such as a title, appraisal or reserve check, and bank-confirmed income. These checks are performed by third parties at a point in time, depend on the information they were given, and may become out of date. They are not audits, appraisals or guarantees by Diamondz, and a passed check does not mean an investment is safe or suitable.",
      ],
    },
    {
      id: "platform",
      title: "Platform risks",
      body: [
        "The Platform may be unavailable, suffer errors or security incidents, or be discontinued. Diamondz earns subscription and service fees from issuers, never a share of the money they raise; still, it has a business interest in issuers using the Platform. Listings marked \"Demo\" use test networks and test tokens with no value and are not offers.",
      ],
    },
    {
      id: "forward",
      title: "Forward-looking statements",
      body: [
        "Offerings may include projections, targets or estimates of future income or value. These are the issuer's opinions about the future and are inherently uncertain; actual results may differ materially.",
      ],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalDoc["slug"], LegalDoc> = { privacy, terms, risk };
