import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();

// Usar raw body para validar webhooks (Shopify envia JSON com HMAC)
app.use("/webhooks/collections_create", express.raw({ type: "application/json" }));

const SHOP = process.env.SHOP;
const ADMIN_API_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

/*Cria o codigo*/
// class SellerCodeGenerator {
//   constructor() {
//     this.N = 26 * 26 * 10;
//     this.A = 101;
//     this.B = 12345;
//     this.letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
//     this.A_inv = this.modInverse(this.A, this.N);
//   }

//   modInverse(a, m) {
//     let m0 = m, x0 = 0, x1 = 1; a = ((a % m) + m) % m;
//     if (m === 1) return 0;
//     while (a > 1) { const q = Math.floor(a / m);[a, m] = [m, a % m];[x0, x1] = [x1 - q * x0, x0]; if (m === 0 && a !== 1) throw new Error("Inverso não existe."); }
//     return (x1 + m0) % m0;
//   }

//   _unpack(codeNum) {
//     const L1 = Math.floor(codeNum / (26 * 10)) % 26;
//     const L2 = Math.floor(codeNum / 10) % 26;
//     const N1 = codeNum % 10;
//     return { L1, L2, N1 };
//   }

//   encodeID(id) {
//     id = Number(id);
//     if (!Number.isInteger(id) || id < 0) throw new Error("ID inválido para codificação.");
//     const idMod = id % this.N;
//     const codeNum = (idMod * this.A + this.B) % this.N;
//     const { L1, L2, N1 } = this._unpack(codeNum);
//     return this.letters[L1] + this.letters[L2] + String(N1);
//   }
// }

class SellerCodeGenerator {
  constructor() {
    this.N = 26 * 100; // 1 letra (26) × 100 números (00–99)
    this.A = 101;
    this.B = 12345;
    this.letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    this.A_inv = this.modInverse(this.A, this.N);
  }

  modInverse(a, m) {
    let m0 = m, x0 = 0, x1 = 1; 
    a = ((a % m) + m) % m;
    if (m === 1) return 0;
    while (a > 1) { 
      const q = Math.floor(a / m);
      [a, m] = [m, a % m];
      [x0, x1] = [x1 - q * x0, x0]; 
      if (m === 0 && a !== 1) throw new Error("Inverso não existe."); 
    }
    return (x1 + m0) % m0;
  }

  _unpack(codeNum) {
    const L1 = Math.floor(codeNum / 100) % 26; // pega a letra
    const N2 = codeNum % 100; // pega os 2 dígitos
    return { L1, N2 };
  }

  encodeID(id) {
    id = Number(id);
    if (!Number.isInteger(id) || id < 0) throw new Error("ID inválido para codificação.");
    const idMod = id % this.N;
    const codeNum = (idMod * this.A + this.B) % this.N;
    const { L1, N2 } = this._unpack(codeNum);
    return this.letters[L1] + String(N2).padStart(2, "0"); // exemplo: A54
  }
}

/*Função que atualiza a coleção no Shopify*/

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


/*Webhook que dispara quando uma coleção é criada*/

app.post("/webhooks/collections_create", async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString("utf8"));
    console.log("Novo evento de coleção criada:", payload);

    const collectionId = `gid://shopify/Collection/${payload.id}`;
    const collectionTitle = payload.title || "Sem nome";

    // Busca o seller_id real no Webkul usando o handle da coleção
    const sellerId = await getSellerIdFromWebkul(payload.handle);
    const coder = new SellerCodeGenerator();
    const sellerCode = coder.encodeID(sellerId);

    // limpa prefixo se já existir
    const cleanTitle = collectionTitle.replace(/^[A-Z]{2}[0-9]\s*\|\s*/, "");
    const newTitle = `${sellerCode} | ${cleanTitle}`;

    const result = await updateCollection(collectionId, newTitle, sellerCode);
    console.log("Atualização:", result);

    res.status(200).send("ok");
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.status(500).send("error");
  }
});

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
