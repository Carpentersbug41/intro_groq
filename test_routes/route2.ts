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
 * Encapsulated function to fetch the API response.
 */
async function fetchApiResponse(payload: any): Promise<string | null> {
  console.log("\n[DEBUG] Sending Payload to API:\n", JSON.stringify(payload, null, 2));

  const startTime = Date.now(); // Start timer for API latency
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const latency = Date.now() - startTime; // Measure latency
    console.log(`[DEBUG] API Call Latency: ${latency}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ERROR] API call failed:\n", errorText);
      throw new Error(`API error: ${response.statusText}`);
    }

    const responseData = await response.json();
    const assistantContent = responseData.choices?.[0]?.message?.content;

    if (!assistantContent) {
      console.warn("[WARN] API returned no content. Raw response:\n", JSON.stringify(responseData, null, 2));
      console.log("[DEBUG] System Fingerprint:\n", responseData?.system_fingerprint);
      return null; // Handle no content case gracefully
    }

    console.log("[DEBUG] API Response Content:\n", assistantContent);
    return assistantContent;
  } catch (error: any) {
    console.error("[ERROR] Failed to fetch API response:\n", error.message);
    return null;
  }
}

/**
 * Retry logic with delay for the second API call.
 */
async function fetchApiResponseWithRetry(payload: any, retries = 1, delayMs = 500): Promise<string | null> {
  let attempt = 0;
  while (attempt <= retries) {
    attempt++;
    console.log(`[DEBUG] Retry Attempt: ${attempt}/${retries}`);
    const response = await fetchApiResponse(payload);
    if (response) return response;

    console.warn(`[WARN] Retry attempt ${attempt}/${retries} failed. Retrying after ${delayMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Minimal validation call to see if user's input is valid or invalid.
 */
async function validateInput(userInput: string, currentPrompt: string): Promise<boolean> {
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
    messages: [{ role: "system", content: validationInstruction }],
    max_tokens: 512,
    temperature: 0.7,
    top_p: 1,
    n: 1,
    stream: false,
  };

  console.log("[DEBUG] Validation Payload:\n", JSON.stringify(payload, null, 2));
  const response = await fetchApiResponse(payload);
  console.log(`[DEBUG] Validation Result: ${response}`);
  return response === "VALID";
}

/**
 * Generates a dynamic retry message if the user’s input is invalid.
 */
async function generateRetryMessage(userInput: string, currentPrompt: string): Promise<string> {
  const payload = {
    model: "llama3-8b-8192",
    messages: [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
    max_tokens: 512,
    temperature: 0.7,
    top_p: 1,
    n: 1,
    stream: false,
  };

  return (await fetchApiResponse(payload)) || "I'm sorry, I couldn't process that. Can you try again?";
}

/**
 * Main request handler.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = body.message?.trim();

    console.log("\n[INFO] Received User Input:", userMessage || "[No Input Provided]");

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
      return new Response(finalMessage, { status: 200 });
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

      const payload1 = {
        model: "llama3-8b-8192",
        messages: conversationHistory,
        max_tokens: 512,
        temperature: 0.7,
        top_p: 1,
        n: 1,
        stream: false,
      };
      console.log("[DEBUG] Token Count for First Call Payload:", payload1.messages.length);
      const assistantContent1 = await fetchApiResponse(payload1);

      if (!assistantContent1) {
        console.warn("[WARN] First API call returned no content. Skipping second call.");
        return new Response("I'm sorry, I couldn't process your response. Please try again.", { status: 200 });
      }

      conversationHistory.push({ role: "assistant", content: assistantContent1 });
      console.log("[DEBUG] First API Response Added to Conversation History.");

      // Insert bogus user input "OK"
      conversationHistory.push({ role: "user", content: "OK" });
      console.log("[DEBUG] Bogus User Input 'OK' Added to Conversation History.");

      currentIndex++;
      const nextPromptForSecondCall = PROMPT_LIST[currentIndex]?.prompt_text;

      if (nextPromptForSecondCall) {
        conversationHistory = [
          { role: "system", content: nextPromptForSecondCall },
          ...conversationHistory.filter((entry) => entry.role !== "system"),
        ];
        console.log("[DEBUG] Updated Conversation History for Second Call:\n", JSON.stringify(conversationHistory, null, 2));

        const payload2 = {
          model: "llama3-8b-8192",
          messages: conversationHistory,
          max_tokens: 512,
          temperature: 0.7,
          top_p: 1,
          n: 1,
          stream: false,
        };
        console.log("[DEBUG] Token Count for Second Call Payload:", payload2.messages.length);
        const assistantContent2 = await fetchApiResponseWithRetry(payload2, 2, 500);

        if (!assistantContent2) {
          console.warn("[WARN] Second API call failed. Falling back to a simpler message.");
          return new Response(assistantContent1, { status: 200 });
        }

        conversationHistory.push({ role: "assistant", content: assistantContent2 });
        console.log("[DEBUG] Second API Response Added to Conversation History.");

        const combinedResponses = `${assistantContent1}\n\n${assistantContent2}`;
        return new Response(combinedResponses, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
    } else {
      console.log("[INFO] Validation Failed. Retrying the Same Prompt.");
      const retryMessage = await generateRetryMessage(userMessage, currentPrompt);
      conversationHistory.push({ role: "assistant", content: retryMessage });
      console.log("[DEBUG] Retry Message Added to Conversation History.");
      return new Response(retryMessage, { status: 200 });
    }
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
