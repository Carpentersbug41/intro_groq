// D:\vercel\intro_groq m6\app\api\chat\route.ts

import PROMPT_LIST from "./prompts"; // Correct path
import { NextRequest, NextResponse } from "next/server";
// Import cookies directly
import { cookies } from 'next/headers';

import { handleDatabaseStorageIfNeeded } from "@/utils/databaseHelpers"; // Temporarily commented out // Re-enable import

import {
  validateInput,
  generateRetryMessage,
  fetchApiResponseWithRetry,
  cleanLlmResponse
} from './openaiApiUtils'; // Adjust path if needed

import {
  getModelForCurrentPrompt,
  RollbackOnValidationFailure
} from './promptUtils';

import {
  handleAutoTransitionHidden,
  handleAutoTransitionVisible
} from './autoTransitionUtils'; // Adjust path if needed

import { chainIfNeeded } from './chainUtils';
import {
  injectNamedMemory,
  updateDynamicBufferMemory,
  saveUserInputToMemoryIfNeeded,   // <-- Added missing import
  processAssistantResponseMemory, // <-- Added missing import
  NamedMemory                     // <-- Type import (keep)
} from './memoryUtils';

import { manageBuffer } from './bufferUtils';
// Import session functions (they now use cookies() internally again)
// /* // Temporarily commented out // Re-enable imports
import {
  getSessionCookieData,
  updateSessionCookieData,
  // destroySession, // If needed
  SessionCookieData // Import the type
} from '@/lib/session';
// */

// --- Constants ---
export const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-2024-07-18";
export const runtime = "nodejs";
export const BUFFER_SIZE = 8; // Default buffer size

// --- Force dynamic rendering ---
export const dynamic = 'force-dynamic';

// --- Interfaces ---
type ConversationEntry = { role: string; content: string };

interface ChatRequestBody {
    messages: ConversationEntry[];
    stream?: boolean; // <-- Keep added optional stream property
}

interface ConversationProcessingInput {
  messagesFromClient: ConversationEntry[];
  sessionData: SessionCookieData;
}

interface HandlerResult {
    content: string | null;
    updatedSessionData: Partial<SessionCookieData> | null;
}

// --- MAIN POST Handler ---
export async function POST(req: NextRequest) {
  // console.log("--- JEST TEST: POST HANDLER ENTERED ---"); // <-- REMOVED LOG

  // --- Get Cookie Store Instance ---
  const cookieStore = await cookies(); // <-- Try awaiting cookies()

  // --- 1. Read Session Cookie Data ---
  // Pass the cookieStore instance to the utility function
  const sessionData = await getSessionCookieData(cookieStore); // <-- Pass cookieStore
  // console.log("API Route Start - Initial Session Data from Cookie:", JSON.stringify(sessionData, null, 2));

  // --- 2. Parse Body & Get History ---
  let body: ChatRequestBody;
  let messagesFromClient: ConversationEntry[];
  try {
    body = await req.json();
    if (!body || !Array.isArray(body.messages)) {
      // console.error("Error parsing request body: 'messages' array missing or invalid.", body);
      return NextResponse.json({ message: "'messages' array is missing or invalid in request body." }, { status: 400 });
    }
    messagesFromClient = body.messages;
    // console.log(`📥 Received Payload: ${messagesFromClient.length} messages.`);
    if (messagesFromClient.length > 0) {
        const lastMsg = messagesFromClient[messagesFromClient.length - 1];
        // console.log(`   Last message (${lastMsg.role}): ${lastMsg.content.substring(0, 80)}...`);
    }
  } catch (err) {
    // console.error("Error parsing request body:", err);
    return NextResponse.json({ message: 'Invalid request body.' }, { status: 400 });
  }

  // --- API Key Check ---
  if (!process.env.OPENAI_API_KEY) {
     // console.error("[FATAL] Missing OPENAI_API_KEY environment variable.");
     return NextResponse.json({ message: 'Server configuration error: Missing API Key.' }, { status: 500 });
  }

  // --- Main Logic ---
  try {
    let result: HandlerResult;

    const processingInput: ConversationProcessingInput = {
        messagesFromClient: messagesFromClient,
        sessionData: sessionData // Pass the initially loaded session data
    };

    if (body.stream === true) { // Check the parsed body, not (body as any) <-- Now valid
        // console.warn("Streaming not fully refactored for hybrid approach yet.");
        return NextResponse.json({ message: 'Streaming not implemented with this state approach yet.' }, { status: 501 });
        // result = await handleStreamingFlow(processingInput); // Needs refactoring
        // Note: handleStreamingFlow would also need cookieStore passed if it modifies session
    } else {
        if (messagesFromClient.length === 0) {
            return NextResponse.json({ message: 'No messages provided in history.' }, { status: 400 });
        }
        // console.log("Calling handleNonStreamingFlow...");
        // Pass the processing input which includes the sessionData read earlier
        result = await handleNonStreamingFlow(processingInput);
        // console.log("handleNonStreamingFlow returned.");
    }

    // === Save State & Send Response ===

    // --- Save Updated Session Data to Cookie ---
    // Check if the handler returned successfully and provided data to save
    if (result && result.updatedSessionData) {
        // console.log("API Route - State to Update Session Cookie:", JSON.stringify(result.updatedSessionData, null, 2));
        // Pass the cookieStore instance AND the update data to the utility function
        await updateSessionCookieData(cookieStore, result.updatedSessionData); // <-- Pass cookieStore
    } else {
        // console.warn("API Route - No updated session data returned from handler or handler failed. Cookie not explicitly saved.");
        // Decide if you need to save even on failure, e.g., resetting index?
        // If handleNonStreamingFlow returns null updatedSessionData on error, this correctly skips saving.
    }

    // --- Send Response ---
    // Check if the handler returned successfully and provided content
    if (result && result.content !== null) {
       const responseContent = result.content;
       // console.log("API Route - Sending response content:", responseContent ? responseContent.substring(0,100)+"..." : "null");
       return new NextResponse(responseContent, {
           status: 200,
           headers: { 'Content-Type': 'text/plain; charset=utf-8' },
       });
    } else {
       // This handles cases where result is undefined (shouldn't happen if try/catch works)
       // OR where result.content is explicitly null (e.g., internal error within the handler)
       // console.error("API Route - Handler function returned null content or result was undefined.");
       // Determine appropriate status code - 500 is generic server error
       return NextResponse.json({ message: 'Processing failed to produce content.' }, { status: 500 });
    }

  } catch (error: any) {
    // Catch errors *outside* the main try block (e.g., initial session read, body parsing)
    // or errors *rethrown* from the main logic block that weren't caught internally
    // console.error("[ERROR] Unhandled exception in POST handler:", error);
    // The specific iron-session check is removed as the pattern is corrected.
    // A generic 500 is appropriate for unexpected errors.
    return NextResponse.json({ message: 'An internal server error occurred.' }, { status: 500 });
  }
} // End of POST function


async function handleNonStreamingFlow(
  input: ConversationProcessingInput
): Promise<HandlerResult> {
  const { messagesFromClient, sessionData } = input;

  // console.log(`>>> [DEBUG][LOG 0] Inside handleNonStreamingFlow - input.sessionData: typeof = ${typeof sessionData}, Value = ${JSON.stringify(sessionData)}`);
  // console.log("Entering handleNonStreamingFlow with session data:", JSON.stringify(sessionData, null, 2));
  // console.log(`   and ${messagesFromClient.length} messages from client.`);

  // --- Step 1: Initialize Local State ---
  let currentIndex = sessionData.currentIndex;
  // Create a deep clone of namedMemory to prevent modifying the original session object reference
  let currentNamedMemory: NamedMemory = JSON.parse(JSON.stringify(sessionData.namedMemory ?? {}));
  let currentBufferSize = sessionData.currentBufferSize;

  // The following check might still be useful if cloning fails, but less likely now
  if (typeof currentNamedMemory !== 'object' || currentNamedMemory === null || Array.isArray(currentNamedMemory)) {
      // console.error(">>> [CRITICAL DEBUG] currentNamedMemory is NOT an object after CLONING! Forcing to {}. Value was:", currentNamedMemory);
      currentNamedMemory = {};
  }
  // console.log(`>>> [DEBUG][LOG 1] After CLONING: typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);


  // --- Prepare History and Get User Message ---
  let currentHistory: ConversationEntry[] = [...messagesFromClient];
  const userMessageEntry = currentHistory[currentHistory.length - 1];
  if (!userMessageEntry || userMessageEntry.role !== 'user') {
      // console.error("[ERROR] handleNonStreamingFlow: Last message is not from user.");
      return { content: "Internal error: Invalid history state.", updatedSessionData: null };
  }
  const userMessage = userMessageEntry.content;

  try {
      // console.log("\n[INFO] Processing User Input:", userMessage.substring(0, 100) + "...");

      // --- Step 2: Process Current Prompt & User Input ---

      // Check for conversation completion *before* processing
      if (currentIndex >= PROMPT_LIST.length) {
           // console.log("[INFO] Conversation Complete (Index out of bounds).");
           return {
               content: "Thank you for your responses! Goodbye.",
               updatedSessionData: { currentIndex, namedMemory: currentNamedMemory, currentBufferSize }
           };
      }

      // Get current prompt details (the one triggered by user input)
      const currentPromptObj = PROMPT_LIST[currentIndex];
      const currentPromptText = currentPromptObj?.prompt_text;
      if (!currentPromptText) {
          // console.error("[ERROR] Current prompt text is missing at index:", currentIndex);
          return { content: "Internal error: Could not retrieve current prompt.", updatedSessionData: null };
      }

      const thisPromptIndex = currentIndex; // Index for DB storage associated with this user message

      const promptValidation = currentPromptObj?.validation;
      const promptValidationNeeded = typeof promptValidation === 'boolean' ? promptValidation : typeof promptValidation === 'string';

      // console.log("\n[DEBUG] Current Prompt Index:", currentIndex);
      // console.log("[DEBUG] Current Prompt Text (snippet):\n", currentPromptText.substring(0, 100) + "...");
      // console.log("[DEBUG] Validation needed?", promptValidationNeeded);

      // 1) Prepare Prompt with Memory (for validation or immediate use)
      // console.log(`>>> [DEBUG][LOG 2] Before injectNamedMemory (currentPrompt): typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);
      const currentPromptWithMemory = injectNamedMemory(currentPromptText, currentNamedMemory);
      // Create history context *just* for validation if needed
      const historyForValidation = [
          { role: "system", content: currentPromptWithMemory },
          ...currentHistory.filter((entry) => entry.role !== "system"),
      ];

      // 2) Save User Input to Memory (if needed, uses currentPromptObj config)
      saveUserInputToMemoryIfNeeded(userMessage, currentPromptObj, currentNamedMemory);
      // console.log(`>>> [DEBUG][LOG 3b] After saveUserInputToMemoryIfNeeded: typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);


      let isStorable = true; // Flag for DB storage
      let finalResponseContent: string | null = null; // Holds the response to send back

      // --- Step 3: Validation Block ---
      if (promptValidationNeeded) {
          // console.log("[INFO] This prompt requires validation.");
          const customValidation = typeof promptValidation === "string" ? promptValidation : undefined;
          const isValid = await validateInput(userMessage, currentPromptWithMemory, customValidation);

          if (!isValid) {
              // Keep currentIndex the same, proceed to main LLM call for this prompt
              // console.log("[INFO] Validation Failed. Will re-run prompt index:", currentIndex);
              isStorable = false; // Don't store interaction if validation failed initially
              // NOTE: Rollback, retry message generation, and early return logic are REMOVED.
          } else {
              // --- Validation Succeeded ---
              // console.log("[INFO] Validation Succeeded.");
              // Increment index *immediately* after successful validation
              currentIndex++;
              // console.log("[INFO] Index incremented due to successful validation. New index:", currentIndex);
              // Now proceed to main LLM call for the *new* currentIndex (if applicable)
              // Check if the new index is out of bounds *after* incrementing
              if (currentIndex >= PROMPT_LIST.length) {
                   // console.log("[INFO] Conversation Complete (reached end after successful validation). Index:", currentIndex);
                   // Need a final message here if conversation ends immediately after validation
                   finalResponseContent = "Thank you! That was the last piece of information needed.";
                   // Return immediately as there's no next prompt to run
                   return {
                       content: finalResponseContent,
                       updatedSessionData: { currentIndex, namedMemory: currentNamedMemory, currentBufferSize }
                   };
              }
              // If not out of bounds, the flow will continue to Step 4 with the incremented index
          }
      } else {
          // --- No validation needed ---
          // console.log("[INFO] No validation needed.");
          // Index will be incremented AFTER the main LLM call in Step 5
      }

      // --- Step 4: Main Flow: Get LLM Response for the *current* prompt (index `currentIndex`) ---
      // currentIndex might have been incremented if validation passed

      // console.log(`>>> [DEBUG][LOG 5] Start of main LLM flow for index ${currentIndex}. typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);

      // Get the prompt object based on the potentially updated currentIndex
      // Important: Use the potentially incremented `currentIndex` here
      const effectivePromptObj = PROMPT_LIST[currentIndex];
      if (!effectivePromptObj) { // Should be caught by the check inside the validation block, but double-check
          // console.error("[ERROR] Attempting to run main flow, but index is out of bounds:", currentIndex);
          // This path might be hit if validation succeeded but there are no more prompts.
          // The check inside the `isValid` block should handle this, but as a safety net:
          return { content: "Thank you, the conversation is complete.", updatedSessionData: { currentIndex, namedMemory: currentNamedMemory, currentBufferSize } };
      }

      // Re-evaluate prompt text with memory for the potentially new index
      const effectivePromptText = effectivePromptObj.prompt_text || "";
      // Use potentially updated memory AND the potentially updated prompt text
      const effectivePromptWithMemory = injectNamedMemory(effectivePromptText, currentNamedMemory); 

      // Update dynamic buffer size based on the prompt that is *about to run* (effectivePromptObj)
      const newBufferSize = updateDynamicBufferMemory(effectivePromptObj, currentBufferSize);
      if (newBufferSize !== currentBufferSize) {
           // console.log(`[BUFFER DYNAMIC] Buffer size changed from ${currentBufferSize} to ${newBufferSize}`);
           currentBufferSize = newBufferSize; // Update local buffer size state
      }
      // console.log("[DEBUG] Effective buffer size for main call:", currentBufferSize);

      // Prepare the *current* system prompt (using currentPromptObj and currentPromptWithMemory)
      // console.log("[DEBUG] Preparing for main LLM call (index", currentIndex, "):", effectivePromptWithMemory.substring(0, 100) + "...");

      // Prepare conversation history for the LLM call
      let historyForLLM = [
          { role: "system", content: effectivePromptWithMemory }, // Use the prompt text for the current index
          ...currentHistory.filter((entry) => entry.role !== "system"), // Use the initial client history for this turn
      ];
      historyForLLM = manageBuffer(historyForLLM, currentBufferSize); // Apply buffer

      // --- Main LLM Call ---
      const mainPayload = {
          model: getModelForCurrentPrompt(currentIndex), // Use potentially updated index
          temperature: effectivePromptObj?.temperature ?? 0,
          messages: historyForLLM, // History is prepared using effectivePromptWithMemory
      };
      // console.log("[DEBUG] Main Payload to LLM (index", currentIndex, "):", JSON.stringify(mainPayload, null, 2));
      const rawAssistantContent = await fetchApiResponseWithRetry(mainPayload);
      const assistantContentCleaned = cleanLlmResponse(rawAssistantContent); // Cleaned LLM response

      if (!assistantContentCleaned) {
          // console.error("[ERROR] Main LLM call failed or returned empty content after retries for index:", currentIndex);
          finalResponseContent = "I'm sorry, I couldn't process that. Please try again.";
          isStorable = false;
          // Return current state even on error, with the error message. Index doesn't advance.
          return {
              content: finalResponseContent,
              updatedSessionData: { currentIndex, namedMemory: currentNamedMemory, currentBufferSize } // Return state at point of failure
          };
      }

      // --- Process Assistant Response Memory (Save & Prefix) ---
      // Uses config for the prompt that just ran (currentPromptObj)
      // console.log("[DEBUG] Processing assistant response memory for index:", currentIndex);
      finalResponseContent = processAssistantResponseMemory(
          assistantContentCleaned,
          effectivePromptObj, // Use the object for the prompt that just ran
          currentNamedMemory,
          currentIndex // Pass updated index for logging
      );
      // console.log(`>>> [DEBUG][LOG 7b] After processAssistantResponseMemory: typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);
      // console.log("[DEBUG] finalResponseContent after memory processing:", finalResponseContent ? finalResponseContent.substring(0, 100) + "..." : "null");

      // --- Create History Context *After* Main LLM Call ---
      // This history includes the response just generated and will be the base for chaining/transitions
      let historyAfterLLM = [
          ...historyForLLM, // History used for the call
          { role: "assistant", content: finalResponseContent } // Add the response we just got
      ];
      // Apply important memory insertion if needed for the context (doesn't affect finalResponseContent directly)
      if (effectivePromptObj.important_memory) {
          // console.log(`[IMPORTANT MEMORY][Index: ${currentIndex}] Applying important memory.`);
          historyAfterLLM = insertImportantMemory(historyAfterLLM, finalResponseContent);
      }


      
  // --- Step 5: Process Response, Check Flag, and Potentially Trigger Transitions ---

  const executedPromptIndex = currentIndex;
  const executedPromptObj = effectivePromptObj;

  // History context for transitions should use the prompt that *actually ran*
  let historyContextForNextStep = [
       { role: "system", content: effectivePromptWithMemory }, // Use prompt for the index that ran
       ...currentHistory.filter((entry) => entry.role !== "system"), // History before the call
       { role: "assistant", content: finalResponseContent } // Add the response we just got
   ];
  // Apply important memory based on the prompt that *actually ran*
  if (executedPromptObj.important_memory) {
      // console.log(`[IMPORTANT MEMORY][Index: ${executedPromptIndex}] Applying important memory.`);
      historyContextForNextStep = insertImportantMemory(historyContextForNextStep, finalResponseContent);
  }


  // Initialize flags/variables for post-processing
  let transitionsWereTriggered = false;
  let finalCombinedContent = finalResponseContent || "";
  let nextIndexAfterProcessing = executedPromptIndex + 1;

  // --- Check if the EXECUTED prompt triggers transitions ---
  // console.log(`\n[DEBUG][FLAG CHECK] Checking flags for prompt index: ${executedPromptIndex}`);
  // console.log(`[DEBUG][FLAG CHECK] Prompt Object text snippet: ${executedPromptObj?.prompt_text?.substring(0, 50)}...`);
  const hasHiddenFlag = executedPromptObj?.autoTransitionHidden === true;
  const hasVisibleFlag = executedPromptObj?.autoTransitionVisible === true;
  // console.log(`[DEBUG][FLAG CHECK] Has autoTransitionHidden flag? ${hasHiddenFlag}`);
  // console.log(`[DEBUG][FLAG CHECK] Has autoTransitionVisible flag? ${hasVisibleFlag}`);


  if (hasHiddenFlag || hasVisibleFlag) {
      // console.log(`\n[DEBUG][TRANSITION TRIGGER] Prompt ${executedPromptIndex} has an autoTransition flag. Preparing transition sequence.`);
      transitionsWereTriggered = true; // Mark that we entered the transition phase

      // Start transition checks from the *next* index
      let currentTransitionIndex = executedPromptIndex + 1;
      // console.log(`[DEBUG][TRANSITION TRIGGER] Starting transition checks from index ${currentTransitionIndex}.`);

      // Adjust initial combined content based on the trigger type
      if (hasHiddenFlag) {
          // console.log("[DEBUG][TRANSITION TRIGGER] Triggering prompt was hidden. Clearing initial response for overwrite by handler(s).");
          finalCombinedContent = ""; // Start blank
      } else {
          // console.log("[DEBUG][TRANSITION TRIGGER] Triggering prompt was visible. Keeping its response as initial combined content.");
          // finalCombinedContent already holds Response N
      }

      // --- Auto-Transition Loops (Start checking from currentTransitionIndex) ---

      // Hidden Loop
      // console.log(`\n[DEBUG][TRANSITION LOOP] Checking for AUTO-HIDDEN transitions starting at index: ${currentTransitionIndex}`);
      while (
          currentTransitionIndex < PROMPT_LIST.length &&
          PROMPT_LIST[currentTransitionIndex]?.autoTransitionHidden
      ) {
          const loopStartIndex = currentTransitionIndex;
          // console.log(`[DEBUG][AUTO-HIDDEN LOOP] Found hidden transition at index ${loopStartIndex}.`);
          const { response: autoResp, updatedIndex, updatedNamedMemory, updatedBufferSize, conversationHistory: historyAfterHidden } =
              await handleAutoTransitionHidden(historyContextForNextStep, currentTransitionIndex, currentNamedMemory, currentBufferSize);
          // Update state
          currentTransitionIndex = updatedIndex; // Handler updates the index
          currentNamedMemory = updatedNamedMemory ?? {};
          currentBufferSize = updatedBufferSize;
          historyContextForNextStep = historyAfterHidden;
          // Hidden responses OVERWRITE
          finalCombinedContent = autoResp ?? "";
          // console.log(`[DEBUG][AUTO-HIDDEN LOOP] Overwrote combined content. Index is now ${currentTransitionIndex}.`);
      }
       // console.log(`[DEBUG][TRANSITION LOOP] Exited AUTO-HIDDEN loop. Current transition index: ${currentTransitionIndex}`);

      // Visible Loop
      // console.log(`\n[DEBUG][TRANSITION LOOP] Checking for AUTO-VISIBLE transitions starting at index: ${currentTransitionIndex}`);
      while (
          currentTransitionIndex < PROMPT_LIST.length &&
          PROMPT_LIST[currentTransitionIndex]?.autoTransitionVisible
      ) {
           const loopStartIndex = currentTransitionIndex;
           // console.log(`[DEBUG][AUTO-VISIBLE LOOP] Found visible transition at index ${loopStartIndex}.`);
           const { response: autoResp, updatedIndex, updatedNamedMemory, updatedBufferSize, conversationHistory: historyAfterVisible } =
              await handleAutoTransitionVisible(historyContextForNextStep, currentTransitionIndex, currentNamedMemory, currentBufferSize);
            // Update state
           currentTransitionIndex = updatedIndex; // Handler updates the index
           currentNamedMemory = updatedNamedMemory ?? {};
           currentBufferSize = updatedBufferSize;
           historyContextForNextStep = historyAfterVisible;
           // Append visible responses
           if (autoResp) {
               const separator = finalCombinedContent ? "\n\n" : "";
               finalCombinedContent += separator + autoResp;
               // console.log(`[DEBUG][AUTO-VISIBLE LOOP] Appended response. Index is now ${currentTransitionIndex}.`);
           } else {
               // console.log("[DEBUG][AUTO-VISIBLE LOOP] Visible handler returned null response. Breaking loop.");
               break;
           }
      }
      // console.log(`[DEBUG][TRANSITION LOOP] Exited AUTO-VISIBLE loop. Current transition index: ${currentTransitionIndex}`);

      // After loops, currentTransitionIndex holds the index of the prompt AFTER the last transition (or the first non-transition prompt)
      nextIndexAfterProcessing = currentTransitionIndex; // Update the final index

      // --- Execute the NEXT NORMAL Prompt if transitions landed on one ---
      // console.log(`\n[DEBUG][POST-TRANSITION] Checking if a final normal prompt needs to run at index: ${nextIndexAfterProcessing}`);
      if (nextIndexAfterProcessing < PROMPT_LIST.length) {
          const nextNormalPromptObj = PROMPT_LIST[nextIndexAfterProcessing];
          if (!nextNormalPromptObj?.autoTransitionHidden && !nextNormalPromptObj?.autoTransitionVisible) {
               // console.log(`[DEBUG][POST-TRANSITION] Transitions occurred and landed on normal prompt ${nextIndexAfterProcessing}. Executing it.`);
               // Update buffer size
               currentBufferSize = updateDynamicBufferMemory(nextNormalPromptObj, currentBufferSize);
               // Prepare prompt text
               const finalPromptText = nextNormalPromptObj.prompt_text || "Error: No prompt text.";
               const finalPromptWithMemory = injectNamedMemory(finalPromptText, currentNamedMemory);
               // Prepare history
               let historyForFinalCall = [
                   { role: "system", content: finalPromptWithMemory },
                   ...historyContextForNextStep.filter((entry) => entry.role !== "system"),
               ];
               historyForFinalCall = manageBuffer(historyForFinalCall, currentBufferSize);
               // Final LLM Call
               const finalPayload = { model: getModelForCurrentPrompt(nextIndexAfterProcessing), temperature: nextNormalPromptObj?.temperature ?? 0, messages: historyForFinalCall };
               const rawFinalAssistantContent = await fetchApiResponseWithRetry(finalPayload);
               const finalAssistantContentCleaned = cleanLlmResponse(rawFinalAssistantContent);

               if (finalAssistantContentCleaned) {
                    // console.log(`[DEBUG][POST-TRANSITION] Final LLM Response Received: "${finalAssistantContentCleaned.substring(0, 100)}..."`);
                    const processedFinalContent = processAssistantResponseMemory(finalAssistantContentCleaned, nextNormalPromptObj, currentNamedMemory, nextIndexAfterProcessing);
                    // Append
                    const separator = finalCombinedContent ? "\n\n" : "";
                    finalCombinedContent += separator + processedFinalContent;
                    // console.log(`[DEBUG][POST-TRANSITION] Appended final prompt response.`);
                    // Increment index one last time *after* successful execution
                    nextIndexAfterProcessing++;
                    // console.log(`[DEBUG][POST-TRANSITION] Incremented index after final prompt. Final index: ${nextIndexAfterProcessing}`);
               } else {
                   // console.warn(`[WARN][POST-TRANSITION] Final LLM call for index ${nextIndexAfterProcessing} failed. Index not incremented.`);
               }
          } else {
               // console.log(`[DEBUG][POST-TRANSITION] Transitions occurred but landed on another transition prompt (${nextIndexAfterProcessing}) or end of list. No final normal prompt executed.`);
          }
      } else {
           // console.log(`[DEBUG][POST-TRANSITION] Transitions finished at end of prompt list (index ${nextIndexAfterProcessing}). No final normal prompt to execute.`);
      }

  } else {
      // The executed prompt did NOT have an auto-transition flag.
      // console.log(`\n[DEBUG][TRANSITION TRIGGER] Prompt ${executedPromptIndex} has NO autoTransition flag. Normal flow, no transitions triggered.`);
      // nextIndexAfterProcessing remains executedPromptIndex + 1 from initialization
      // console.log(`[DEBUG] Index for next turn will be: ${nextIndexAfterProcessing}.`);
      // finalCombinedContent remains the response from the executed prompt.
  }

  // --- Update finalResponseContent and currentIndex for saving ---
  finalResponseContent = finalCombinedContent;
  // Always use the index calculated after step 5 unless an error stopped processing earlier
  currentIndex = nextIndexAfterProcessing;
  // console.log("[DEBUG] Index determined after Step 5 (transitions/increment):", currentIndex);






      // --- Step 6: Store and Return Final State ---

      console.log("[DEBUG] Reached end of processing for this turn. Final index to save FOR NEXT TURN:", currentIndex);

      // Store final interaction result if needed (use the original prompt index `thisPromptIndex`)
      if (isStorable) {
          const contentToStore = finalResponseContent ?? ""; // Ensure we store a string
          // await handleDatabaseStorageIfNeeded(thisPromptIndex, contentToStore, userMessage);
          // console.log("[DB-DEBUG] Storing final content for original prompt index:", thisPromptIndex);
      } else {
          // console.log("[DB-DEBUG] Interaction was marked non-storable. Skipping storage for original prompt index:", thisPromptIndex);
      }

      // console.log(`>>> [DEBUG][LOG 8] Before final return: typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);
      // console.log("handleNonStreamingFlow final session state to save:", JSON.stringify({ currentIndex, namedMemory: currentNamedMemory, currentBufferSize }, null, 2));

      return {
          content: finalResponseContent, // The final content after all processing
          updatedSessionData: {
              // FIX: Use original index (thisPromptIndex) if validation failed (isStorable=false),
              // otherwise use the potentially advanced index (currentIndex which holds nextIndexAfterProcessing)
              currentIndex: isStorable ? currentIndex : thisPromptIndex,
              namedMemory: currentNamedMemory,
              currentBufferSize: currentBufferSize
          }
      };

  } catch (error: any) {
      console.error("[JEST_DEBUG] ERROR CAUGHT in handleNonStreamingFlow:", error); // <-- ADD LOG
      // console.error("[ERROR] Unhandled exception in handleNonStreamingFlow:", error);
      // console.log(`>>> [DEBUG][LOG 9 - ERROR CATCH] State before error return: typeof currentNamedMemory = ${typeof currentNamedMemory}, Value = ${JSON.stringify(currentNamedMemory)}`);
      // Return null update data to avoid saving partial/incorrect state on unexpected errors
      return { content: "An internal server error occurred during processing.", updatedSessionData: null };
  } finally {
      // console.log("Exiting handleNonStreamingFlow.");
  }
} // End of handleNonStreamingFlow


// --- insertImportantMemory (Helper used within handleNonStreamingFlow) ---
// NOTE: This function MUST return the modified history.
// It should be called like: historyAfterLLM = insertImportantMemory(historyAfterLLM, ...)
function insertImportantMemory(conversationHistory: ConversationEntry[], content: string): ConversationEntry[] {
    const updatedHistory = [...conversationHistory]; // Work on a copy
    const systemIndex = updatedHistory.findIndex((msg) => msg.role === "system");
    let insertIndex = systemIndex !== -1 ? systemIndex + 1 : 0; // Insert after system or at start

    // Skip past any existing important memory lines right after system prompt
    while (
        insertIndex < updatedHistory.length &&
        updatedHistory[insertIndex].role === "assistant" &&
        updatedHistory[insertIndex].content.trim().startsWith("Important_memory:")
    ) {
        insertIndex++;
    }

    // Insert the new important memory
    updatedHistory.splice(insertIndex, 0, {
        role: "assistant", // Role should likely be assistant for memory
        content: `Important_memory: ${content}`
    });

    // console.log("[DEBUG] Important_memory helper inserted at index:", insertIndex);
    return updatedHistory; // Return the modified array
}
// --- handleStreamingFlow ---
// NOTE: This function uses global variables (conversationHistory, currentBufferSize, currentIndex)
// which is inconsistent with the state management in handleNonStreamingFlow.
// It needs significant refactoring to work correctly with the session cookie state model.
// For now, it remains as provided but is likely non-functional in the current setup.
let conversationHistory: ConversationEntry[] = []; // Example global state (problematic)
let currentBufferSize = BUFFER_SIZE; // Example global state (problematic)
let currentIndex = 0; // Example global state (problematic)

async function handleStreamingFlow(incomingMessage: string): Promise<Response> {
  // console.log("[INFO] [STREAM MODE] Received request for streaming.");
  // console.warn("[WARNING] handleStreamingFlow uses outdated global state and needs refactoring for session cookie model.");

  if (!incomingMessage?.trim()) {
    // console.log("[WARN] No User Input Received. Returning Error.");
    return new Response("No input received. Please try again.", { status: 400 });
  }

  // This uses global state, which won't reflect the actual session
  conversationHistory.push({ role: "user", content: incomingMessage });
  conversationHistory = manageBuffer(conversationHistory, currentBufferSize); // Uses global buffer size

  const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts."; // Uses global index
  conversationHistory.unshift({ role: "system", content: currentPrompt });

  const payload = {
    model: DEFAULT_OPENAI_MODEL,
    temperature: 0,
    stream: true,
    messages: conversationHistory, // Uses global history
  };

  const resp = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) { // Check !resp.ok separately first
    const errorText = await resp.text();
    // console.error("[ERROR] streaming request failed:\n", errorText);
    return new Response("Error calling streaming LLM API.", { status: 500 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const transformStream = new TransformStream();
  const writable = transformStream.writable.getWriter();

  (async () => {
    // Check for resp.body *inside* the async IIFE, before using it
    if (!resp.body) {
      // console.error("[ERROR] Response body is null, cannot stream.");
      // Need to handle this error within the async function, maybe close the writer
      await writable.close(); 
      return; // Exit the async function
    }
    try {
      for await (const chunk of streamAsyncIterable(resp.body)) { // Now resp.body is guaranteed non-null here
        const data = decoder.decode(chunk);
        const lines = data.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.startsWith("data: [DONE]")) {
            await writable.write(encoder.encode(`data: [DONE]\n\n`));
            await writable.close();
            return;
          }
          await writable.write(encoder.encode(`${line}\n`));
        }
      }
    } catch (e) {
      // console.error("[ERROR] in SSE streaming:", e);
      await writable.close(); // Ensure writer is closed on error
    } finally {
       // Ensure writer is closed if loop finishes unexpectedly
       // await writable.close(); // This might cause issues if already closed. Check logic.
    }
  })();

  return new Response(transformStream.readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}


/**
 * Helper to turn a ReadableStream into an async iterable
 */
async function* streamAsyncIterable(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

