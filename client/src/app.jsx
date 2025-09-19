// src/App.jsx
import React, { useRef, useState } from "react";
import { Motion, motion } from "framer-motion";
import { Upload, Mic, ShoppingCart, Users, Download } from "lucide-react";

const SERVER = "http://localhost:5000"; // change if your server is remote

export default function App() {
  const [role, setRole] = useState(null);
  const [photo, setPhoto] = useState("");
  const [form, setForm] = useState({
    productName: "Handmade Basket",
    craftType: "Basketry",
    materials: "bamboo",
    region: "Odisha",
    artisanName: "Lata Devi",
    baseCost: 350,
  });
  const [aiText, setAiText] = useState(null);
  const [generatedImgUrl, setGeneratedImgUrl] = useState(null);
  const fileRef = useRef();

  // upload local file preview
  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setPhoto(url);
  }

  async function generateText() {
    const prompt = `Create JSON with title, description, story, tags (comma separated), caption and price for the craft. Details: ${JSON.stringify(
      form
    )}`;
    const res = await fetch(`${SERVER}/api/generate-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const json = await res.json();
    // try to parse structured JSON in text; otherwise show raw text
    let parsed = null;
    if (json?.text) {
      try {
        parsed = JSON.parse(json.text);
      } catch (e) {
        parsed = { text: json.text };
      }
    } else parsed = json;
    setAiText(parsed);
  }

  async function generateImagenMockup() {
    const prompt = `${form.productName}, ${form.craftType}, professional product photo, studio lighting`;
    const res = await fetch(`${SERVER}/api/generate-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const json = await res.json();
    if (json?.url) {
      setGeneratedImgUrl(json.url);
      setPhoto(json.url);
    } else {
      alert("Image generation failed; check server logs");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-yellow-50 to-white p-6">
      {!role ? (
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl font-bold mb-6">Artisan Co-Creator</h1>
          <div className="flex justify-center gap-4">
            <button onClick={() => setRole("seller")} className="px-6 py-3 bg-emerald-600 text-white rounded-xl">
              <Users /> Seller
            </button>
            <button onClick={() => setRole("consumer")} className="px-6 py-3 bg-slate-100 rounded-xl">
              <ShoppingCart /> Consumer
            </button>
          </div>
        </div>
      ) : role === "seller" ? (
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold mb-4">Seller Studio</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label>Product name</label>
              <input value={form.productName} onChange={(e) => setForm({ ...form, productName: e.target.value })} />
              <label>Craft type</label>
              <input value={form.craftType} onChange={(e) => setForm({ ...form, craftType: e.target.value })} />
              <label>Materials</label>
              <input value={form.materials} onChange={(e) => setForm({ ...form, materials: e.target.value })} />
              <label>Region</label>
              <input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
              <label>Artisan</label>
              <input value={form.artisanName} onChange={(e) => setForm({ ...form, artisanName: e.target.value })} />
              <div className="mt-3">
                <input type="file" accept="image/*" ref={fileRef} onChange={handleFile} />
                <button onClick={() => fileRef.current?.click()}>Upload photo</button>
                <button onClick={generateImagenMockup}>Generate mockup (Imagen)</button>
              </div>
              <div className="mt-3">
                <button onClick={generateText} className="px-4 py-2 bg-emerald-600 text-white rounded-xl">
                  Generate Description (Vertex)
                </button>
              </div>
            </div>

            <div>
              <div className="bg-white p-4 rounded-xl">
                <h4 className="font-bold">Preview</h4>
                {photo ? <img src={photo} alt="preview" className="w-full rounded-md mt-2" /> : <div className="h-40 border rounded-md mt-2 flex items-center justify-center">No image</div>}
                {aiText && (
                  <pre className="mt-3 bg-gray-50 p-3 rounded-md text-sm overflow-auto">
                    {typeof aiText === "string" ? aiText : JSON.stringify(aiText, null, 2)}
                  </pre>
                )}
                {generatedImgUrl && (
                  <div className="mt-3">
                    <a href={generatedImgUrl} target="_blank" rel="noreferrer" className="px-3 py-2 bg-blue-500 text-white rounded-md inline-block">
                      View generated image
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        // consumer page simplified for demo
        <div className="max-w-6xl mx-auto">
          <h2 className="text-2xl font-bold">Marketplace</h2>
          <p>Browse curated artisan goods (demo content)</p>
        </div>
      )}
    </div>
  );
}

