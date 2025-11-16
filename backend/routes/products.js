const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { storage } = require("../utils/cloudinary");
const upload = multer({ storage });
const { spawn } = require("child_process");
const path = require("path");
const router = express.Router();
const Product = require("../models/Product");

// GET all products
router.get("/", async (req, res) => {
  try {
    const products = await Product.find();
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST new product with Cloudinary + Python counterfeit check
router.post("/", upload.single("image"), async (req, res) => {
  try {
    console.log("🔹 [POST] Product upload triggered.");
    const { title, brand, description, price } = req.body;
    console.log("📝 Form Fields:", { title, brand, description, price });

    const imageUrl = req.file?.path || req.file?.secure_url || req.body.image;
    if (!imageUrl)
      throw new Error("Image upload failed: No image path provided.");
    console.log("🖼️ Image URL:", imageUrl);

    const inputPayload = JSON.stringify({
      title,
      brand,
      description,
      image_url: imageUrl,
    });

    const scriptPath = path.resolve(
      __dirname,
      "../../ml/predict_counterfeit.py"
    );

    const python = spawn("py", ["-3.11", scriptPath]);

    let result = "";
    let errorOutput = "";

    python.stdin.write(inputPayload);
    python.stdin.end();

    python.stdout.on("data", (data) => {
      const chunk = data.toString();
      console.log("📥 [Python stdout]:", chunk);
      result += chunk;
    });

    python.stderr.on("data", (data) => {
      const err = data.toString();
      console.error("❌ [Python stderr]:", err);
      errorOutput += err;
    });

    python.on("close", async () => {
      if (errorOutput) console.error("⚠️ Python stderr output:", errorOutput);

      try {
        const output = JSON.parse(result);

        const payload = {
          title,
          brand,
          description,
          price,
          imageUrl,
          isCounterfeit: output.prediction === 1,
          predictionConfidence: output.confidence,
          explanation: output.explanation,
        };

        const product = new Product(payload);
        await product.save();
        res.status(201).json(product);
      } catch (err) {
        res.status(500).json({
          message: "Counterfeit detection failed",
          error: err.message,
        });
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});

// ----------------------------------------------------
// 🔥 RULE-BASED FAKE REVIEW DETECTOR
// ----------------------------------------------------
function ruleBasedFakeDetector(text) {
  const lower = text.toLowerCase();

  const exaggeration = [
    "best", "perfect", "life-changing", "ultimate", "unbelievable",
    "world's best", "100%", "must buy", "greatest", "mind blowing",
    "insane product", "changed my life",
  ];

  const indianExaggeration = [
    // Kannada
    "ಅತ್ಯುತ್ತಮ", "ಪರಿಪೂರ್ಣ", "ಅದ್ಭುತ", "ಜೀವನ ಬದಲಾಯಿಸಿತು",
    // Tamil
    "சிறந்த", "அற்புதம்", "மிகவும் சிறந்தது", "உலகிலேயே சிறந்தது",
    // Hindi
    "सबसे अच्छा", "अद्भुत", "जीवन बदल", "कमाल", "एकदम सही",
    // Telugu
    "అద్భుతం", "అత్యుత్తమ", "వెరీ బెస్ట్", "జీవితాన్ని మార్చింది",
  ];

  const marketing = [
    "buy now", "must buy", "don't miss", "limited offer",
    "ಈಗಲೇ ಖರೀದಿ ಮಾಡಿ", "உடனே வாங்க", "వెంటనే కొనండి",
    "offer", "discount", "grab it fast",
  ];

  const emojiRegex =
    /[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F90D}-\u{1F9FF}]/u;

  if (emojiRegex.test(text) && !lower.match(/\b(bad|issue|problem|poor|complaint)\b/)) {
    return true;
  }

  if (exaggeration.some((w) => lower.includes(w))) return true;
  if (indianExaggeration.some((w) => text.includes(w))) return true;

  if (marketing.some((w) => lower.includes(w) || text.includes(w))) return true;

  if (
    text.length > 350 &&
    !lower.match(/\b(bad|issue|problem|average|poor|complaint|ok|not good)\b/)
  ) {
    return true;
  }

  return false;
}

// ----------------------------------------------------
// POST Review (Hybrid Rule-Based + AI Detection)
// ----------------------------------------------------
router.post("/:id/reviews", async (req, res) => {
  const { reviewer, comment, rating } = req.body;

  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });

    // 1️⃣ Very short reviews → probably real
    if (comment.trim().split(/\s+/).length < 6) {
      product.reviews.push({
        reviewer,
        comment,
        rating,
        classification: "Real",
        explanation: "Short positive reviews are treated as genuine.",
      });
      await product.save();
      return res.status(201).json(product);
    }

    // 2️⃣ Rule-based detection first
    if (ruleBasedFakeDetector(comment)) {
      product.reviews.push({
        reviewer,
        comment,
        rating,
        classification: "Fake",
        explanation: "Detected exaggerated/emoji/marketing patterns.",
      });
      await product.save();
      return res.status(201).json(product);
    }

    // 3️⃣ AI fallback
    const prompt = `
You are a multilingual fake review detector.
You MUST classify the review as Fake if it contains:
- Exaggeration in ANY language (Kannada, Tamil, Telugu, Hindi, etc.)
- Emojis used for hype
- Marketing pressure ("buy now", "don't miss", etc.)
- Unnatural hype, too positive tone
- No product-specific details
- Emotional storytelling with no real usage

Real reviews contain actual usage experience.

Respond ONLY in this format:
Classification: Fake or Real
Explanation: <one-line>

Review: """${comment}"""
`;

    const aiRes = await axios.post(
      "http://localhost:5001/v1/chat/completions",
      {
        model: "mistral-7b-instruct-v0.2",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 80,
      }
    );

    const output = aiRes.data.choices[0].message.content;

    const classification =
      output.match(/Classification:\s*(Fake|Real)/i)?.[1] || "Fake";
    const explanation =
      output.match(/Explanation:\s*(.*)/i)?.[1]?.trim() ||
      "AI analysis failed.";

    product.reviews.push({
      reviewer,
      comment,
      rating,
      classification,
      explanation,
    });

    await product.save();
    res.status(201).json(product);
  } catch (err) {
    console.error("❌ Review Error:", err.message);
    res.status(500).json({ message: "Failed to add review" });
  }
});

// GET product by ID
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET all reviews for moderator
router.get("/moderator/reviews", async (req, res) => {
  try {
    const products = await Product.find();
    const allReviews = [];

    products.forEach((product) => {
      product.reviews.forEach((review) => {
        allReviews.push({
          productId: product._id,
          productTitle: product.title,
          ...review._doc,
        });
      });
    });

    res.json(allReviews);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE review
router.delete("/:productId/reviews/:reviewId", async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    product.reviews = product.reviews.filter(
      (r) => r._id.toString() !== reviewId
    );

    await product.save();
    res.json({ message: "Review deleted" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete review" });
  }
});

// PUT review
router.put("/:productId/reviews/:reviewId", async (req, res) => {
  try {
    const { productId, reviewId } = req.params;
    const { classification, explanation } = req.body;

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    const review = product.reviews.id(reviewId);
    if (!review) return res.status(404).json({ message: "Review not found" });

    review.classification = classification;
    review.explanation = explanation;

    await product.save();
    res.json({ message: "Review updated" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update review" });
  }
});

// Review stats
router.get("/moderator/review-stats", async (req, res) => {
  try {
    const products = await Product.find();
    let fake = 0;
    let real = 0;

    products.forEach((product) => {
      product.reviews.forEach((review) => {
        if (review.classification === "Fake") fake++;
        else if (review.classification === "Real") real++;
      });
    });

    res.json({ fake, real });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Product stats
router.get("/moderator/product-stats", async (req, res) => {
  try {
    const counterfeit = await Product.countDocuments({
      isCounterfeit: true,
    });
    const genuine = await Product.countDocuments({
      isCounterfeit: false,
    });

    res.json({ counterfeit, genuine });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE product
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted)
      return res.status(404).json({ message: "Product not found" });

    res.status(200).json({ message: "Product deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
