import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";

dotenv.config();
const app = express();

app.use("/webhooks/collections_create", express.raw({ type: "application/json" }));

const SHOP = process.env.SHOP;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Caminho do arquivo onde os códigos são armazenados
const CODES_FILE = path.resolve("./data/codes.txt");

/* Classe de geração e controle de códigos*/
class SellerCodeGenerator {
  constructor() {
    this.letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    this.maxAttempts = 20;
    if (!fs.existsSync(CODES_FILE)) {
      fs.writeFileSync(CODES_FILE, "[]", "utf8");
      console.log("📄 Arquivo codes.txt criado.");
    } else {
      console.log("📁 Arquivo codes.txt encontrado.");
    }
  }

  // Carrega lista de códigos existentes
  _loadCodes() {
    try {
      const data = fs.readFileSync(CODES_FILE, "utf8");
      return JSON.parse(data);
    } catch (e) {
      console.warn("⚠️ Erro ao ler codes.txt, recriando...");
      fs.writeFileSync(CODES_FILE, "[]", "utf8");
      return [];
    }
  }

  // Salva lista de códigos atualizada
  _saveCodes(codes) {
    fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2), "utf8");
  }

  // Gera número base a partir do seller_id
  _generateBaseNumber(id) {
    const hash = crypto.createHash("md5").update(String(id)).digest("hex");
    const num = parseInt(hash.slice(0, 4), 16) % 2600;
    return num;
  }

  // Converte número em formato LNN
  _toCode(num) {
    const L1 = Math.floor(num / 100) % 26;
    const N2 = num % 100;
    return this.letters[L1] + String(N2).padStart(2, "0");
  }

  // Fallback: formato LLN
  _generateExtendedCode() {
    const L1 = this.letters[Math.floor(Math.random() * 26)];
    const L2 = this.letters[Math.floor(Math.random() * 26)];
    const N = Math.floor(Math.random() * 10);
    return `${L1}${L2}${N}`;
  }

  // Função principal de geração segura
  generateUniqueCode(id) {
    const used = this._loadCodes();
    let baseNum = this._generateBaseNumber(id);
    let code = this._toCode(baseNum);
    let attempts = 0;

    while (used.includes(code)) {
      attempts++;
      console.warn(`⚠️ Código duplicado detectado (${code}), tentativa ${attempts}`);
      if (attempts > this.maxAttempts) {
        code = this._generateExtendedCode();
        if (!used.includes(code)) break;
      }
      baseNum = (baseNum + Math.floor(Math.random() * 37) + 1) % 2600;
      code = this._toCode(baseNum);
    }

    used.push(code);
    this._saveCodes(used);
    console.log(`✅ Código gerado com sucesso: ${code}`);
    return code;
  }
}

/* Atualiza coleção no Shopify */
async function updateCollection(id, title, code) {
  const mutation = `
    mutation updateCollection($id: ID!, $code: String!, $title: String!) {
      collectionUpdate(input: {
        id: $id,
        title: $title,
        metafields: [
          { namespace: "custom", key: "booth_s_number", type: "single_line_text_field", value: $code }
        ]
      }) {
        collection {
          id
          title
          metafield(namespace:"custom", key:"booth_s_number") { value }
        }
        userErrors { field message }
      }
    }
  `;

  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query: mutation, variables: { id, code, title } }),
  });

  return await res.json();
}

/* Busca Seller ID no Webkul via handle */
async function getSellerIdFromWebkul(handle) {
  const apiUrl = new URL("https://mvmapi.webkul.com/api/v2/public/sellers.json");
  apiUrl.searchParams.append("shop_name", SHOP);
  apiUrl.searchParams.append("filter", JSON.stringify({ handle }));

  const response = await fetch(apiUrl);
  if (!response.ok) throw new Error("Erro ao buscar seller na API Webkul");
  const data = await response.json();

  if (data.sellers && data.sellers.length > 0 && data.sellers[0].seller_id) {
    return data.sellers[0].seller_id;
  } else {
    throw new Error(`Nenhum vendedor encontrado com handle ${handle}`);
  }
}

// TESTE LOCAL
// async function getSellerIdFromWebkul(handle) {
//   console.log(`🧪 [MOCK] Simulando busca do vendedor "${handle}"`);
//   return Math.floor(Math.random() * 999999); // retorna ID fake
// }

async function getCollectionMetafield(collectionGID) {
  const query = `
    {
      node(id: "${collectionGID}") {
        ... on Collection {
          metafields(first:10, namespace:"custom") {
            edges { node { key value } }
          }
        }
      }
    }
  `;
  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  const json = await res.json();
  const metafields = json.data?.node?.metafields?.edges?.map(e => e.node) || [];
  const booth = metafields.find(m => m.key === "booth_s_number");
  return booth?.value || null;
}

async function updateCollectionTitle(collectionGID, newTitle) {
  const mutation = `
    mutation updateCollection($id: ID!, $title: String!) {
      collectionUpdate(input: { id: $id, title: $title }) {
        collection { id title }
        userErrors { field message }
      }
    }
  `;

  const res = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query: mutation, variables: { id: collectionGID, title: newTitle } }),
  });

  return res.json();
}

/* Webhook: coleção criada */
app.post("/webhooks/collections_create", async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString("utf8"));
    console.log("🆕 Nova coleção criada:", payload.title);

    const collectionId = `gid://shopify/Collection/${payload.id}`;
    const collectionTitle = payload.title || "Sem nome";

    // Busca seller_id via Webkul
    const sellerId = await getSellerIdFromWebkul(payload.handle);

    // Gera código único com fallback se necessário
    const coder = new SellerCodeGenerator();
    const sellerCode = coder.generateUniqueCode(sellerId);

    // Atualiza o título com prefixo do código
    const cleanTitle = collectionTitle.replace(/^[A-Z]{2,3}\d?\s*\|\s*/, "");
    const newTitle = `${sellerCode} | ${cleanTitle}`;

    // Atualiza a coleção no Shopify
    const result = await updateCollection(collectionId, newTitle, sellerCode);
    console.log("🧠 Resultado:", result);

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro no webhook:", err);
    res.status(500).send("error");
  }
});

app.post("/webhooks/shopify/collection_update", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString("utf8"));
    const collectionId = `gid://shopify/Collection/${payload.id}`;
    const currentTitle = payload.title || "";

    const code = await getCollectionMetafield(collectionId);
    if (!code) {
      console.log("🟡 Nenhum booth_s_number encontrado, ignorando...");
      return res.status(200).send("no code");
    }

    if (!currentTitle.startsWith(`${code} |`)) {
      const clean = currentTitle.replace(/^[A-Z]{2,3}\d?\s*\|\s*/, "").trim();
      const newTitle = `${code} | ${clean}`;
      await updateCollectionTitle(collectionId, newTitle);
      console.log(`🔁 Prefixo reaplicado automaticamente: ${newTitle}`);
    } else {
      console.log(`✅ Prefixo preservado: ${currentTitle}`);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro no webhook collection_update:", err);
    res.status(500).send("error");
  }
});

/* Webkul seller_update */
app.post("/webhooks/webkul/seller_update", express.json(), async (req, res) => {
  try {
    const { handle, name } = req.body;

    if (!handle || !name) {
      return res.status(400).send("handle e name são obrigatórios");
    }

    const response = await fetch(`https://${SHOP}/admin/api/2025-01/custom_collections.json?handle=${handle}`, {
      headers: { "X-Shopify-Access-Token": ADMIN_API_TOKEN },
    });
    const data = await response.json();
    const collection = data.custom_collections?.[0];

    if (!collection) {
      console.log("⚠️ Nenhuma coleção encontrada para handle:", handle);
      return res.status(404).send("no collection");
    }

    const collectionGID = `gid://shopify/Collection/${collection.id}`;
    const code = await getCollectionMetafield(collectionGID);
    if (!code) {
      console.log("⚠️ Nenhum booth_s_number nessa coleção, ignorando...");
      return res.status(200).send("no code");
    }

    const clean = collection.title.replace(/^[A-Z]{2,3}\d?\s*\|\s*/, "").trim();
    const newTitle = `${code} | ${name || clean}`;
    await updateCollectionTitle(collectionGID, newTitle);

    console.log(`🆕 Nome do vendedor atualizado mantendo prefixo: ${newTitle}`);
    res.status(200).send("ok");
  } catch (err) {
    console.error("❌ Erro no webhook seller_update:", err);
    res.status(500).send("error");
  }
});

/* Inicialização do servidor */
app.listen(3000, () => console.log("Servidor rodando na porta 3000 🚀"));
