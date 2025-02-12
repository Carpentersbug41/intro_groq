import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const PROMPT_LIST = [
  { prompt_text: "Ask the user what their favorite color is." },
  { prompt_text: "Ask the user what their favorite dish is." },
  { prompt_text: "Ask the user what their favorite type of music is." },
  { prompt_text: "Ask the user what their favorite movie is." },
  { prompt_text: "Ask the user what their favorite book is." },
  { prompt_text: "Ask the user what their dream vacation destination is." },
  { prompt_text: "Ask the user what their favorite animal is." },
  { prompt_text: "Ask the user what their favorite hobby is." },
];

let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

/**
 * Minimal validation call to see if user's input is valid or invalid.
 */
async function validateInput(userInput: string, currentPrompt: string) {
  const validationInstruction = `
    You are a validation assistant.
    Your task is to assess whether the user's input matches the prompt's requirements.
    Current prompt: '${currentPrompt}'
    User input: '${userInput}'
    
    Respond with only one word: "VALID" if the input matches the prompt's requirement, or "INVALID" if it does not.
    Do not provide any additional explanation or description.
  `;

  const payload = {
    model: "llama3-8b-8192",
    messages: [
      { role: "system", content: validationInstruction },
    ],
  };

  console.log("\n[DEBUG] Validation Payload Sent to API:\n", JSON.stringify(payload, null, 2));

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[ERROR] Validation API call failed:\n", errorText);
    throw new Error(`Validation API error: ${response.statusText}`);
  }

  const responseData = await response.json();
  const validationResult = responseData.choices?.[0]?.message?.content?.trim() || "INVALID";
  console.log("[DEBUG] Validation Result:\n", validationResult);

  console.log("[DEBUG] Validation Result Interpretation:");
  console.log("Expected: 'VALID' or 'INVALID'");
  console.log("Received:", validationResult);
  console.log("Validation Outcome:", validationResult === "VALID" ? "Success" : "Failure");

  console.log("[DEBUG] Validation Associated with Prompt:\n", currentPrompt);
  return validationResult === "VALID";
}

/**
 * Generates a dynamic retry message if the user’s input is invalid.
 */
async function generateRetryMessage(userInput: string, currentPrompt: string) {
  const payload = {
    model: "llama3-8b-8192",
    messages: [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
  };

  console.log("\n[DEBUG] Retry Payload Sent to API (System Prompt First):\n", JSON.stringify(payload, null, 2));

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[ERROR] Retry API call failed:\n", errorText);
    throw new Error(`Retry API error: ${response.statusText}`);
  }

  const responseData = await response.json();
  const retryContent = responseData.choices?.[0]?.message?.content;

  if (!retryContent) {
    throw new Error("Invalid retry response: No content.");
  }

  console.log("[DEBUG] Retry Message Generated:\n", retryContent);

  console.log("[DEBUG] Updated Conversation History (System Prompt First):\n", JSON.stringify([
    { role: "system", content: currentPrompt },
    ...conversationHistory.filter((entry) => entry.role !== "system"),
  ], null, 2));

  return retryContent;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = body.message?.trim();

    console.log("\n[INFO] Received User Input:\n", userMessage || "[No Input Provided]");

    if (!userMessage) {
      console.log("[WARN] No User Input Received. Returning Error.");
      return new Response("No input received. Please try again.", { status: 400 });
    }

    const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
    console.log("\n[DEBUG] Current Prompt:\n", currentPrompt);

    if (!currentPrompt) {
      const finalMessage = "Thank you for your responses! Goodbye.";
      conversationHistory.push({ role: "assistant", content: finalMessage });
      console.log("[INFO] Conversation Complete. Final Message Sent.");
      return new Response(finalMessage, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    conversationHistory = [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    conversationHistory.push({ role: "user", content: userMessage });
    console.log("[DEBUG] Adding User Input to Conversation History.");

    console.log("[INFO] Validating User Input with prompt:", currentPrompt);
    const isValid = await validateInput(userMessage, currentPrompt);

    if (isValid) {
      console.log("[INFO] User Input Validated Successfully.");

      currentIndex++;
      console.log("[DEBUG] Updated Current Index:", currentIndex);

      const nextPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
      console.log("[DEBUG] Next Prompt to Be Processed:", nextPrompt);

      conversationHistory = [
        { role: "system", content: nextPrompt },
        ...conversationHistory.filter((entry) => entry.role !== "system"),
      ];
      console.log("[DEBUG] Updated Conversation History for Next Prompt (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

      const mainPayload = {
        model: "llama3-8b-8192",
        messages: conversationHistory,
      };

      console.log("\n[DEBUG] Main Payload Sent to API (System Prompt First):\n", JSON.stringify(mainPayload, null, 2));

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(mainPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[ERROR] Groq API call failed:\n", errorText);
        throw new Error(`Groq API error: ${response.statusText}`);
      }

      const responseData = await response.json();
      const assistantContent = responseData.choices?.[0]?.message?.content;

      if (!assistantContent) {
        throw new Error("No content received in API response.");
      }

      conversationHistory.push({ role: "assistant", content: assistantContent });
      console.log("[DEBUG] Updated Conversation History:\n", JSON.stringify(conversationHistory, null, 2));

      return new Response(assistantContent, { status: 200, headers: { "Content-Type": "text/plain" } });
    } else {
      console.log("[INFO] Validation Failed. Retrying the Same Prompt.");
      const retryMessage = await generateRetryMessage(userMessage, currentPrompt);
      conversationHistory.push({ role: "assistant", content: retryMessage });
      console.log("[DEBUG] Retry Message Added to Conversation History.");
      return new Response(retryMessage, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
