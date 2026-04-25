import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 500 });
  }

  const { imageBase64 } = await req.json();
  if (!imageBase64) {
    return NextResponse.json({ error: "No image provided" }, { status: 400 });
  }

  const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");

  const response = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64Data },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || JSON.stringify(data);
    console.error("Vision API error:", errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }

  const annotation = data.responses?.[0];
  if (annotation?.error) {
    console.error("Vision API response error:", annotation.error);
    return NextResponse.json({ error: annotation.error.message }, { status: 500 });
  }

  const text = annotation?.fullTextAnnotation?.text || "";
  return NextResponse.json({ text });
}
