async function handleNonStreamingFlow(incomingMessage: string): Promise<Response> {
    try {
      const userMessage = incomingMessage?.trim();
  
      console.log("\n[INFO] Received User Input:", userMessage || "[No Input Provided]");
      if (!userMessage) {
        console.log("[WARN] No User Input Received. Returning Error.");
        return new Response("No input received. Please try again.", { status: 400 });
      }
  
      // Capture the current prompt and its "important_memory" flag before any changes.
      const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
      const thisPromptImportant = PROMPT_LIST[currentIndex]?.important_memory;  // Capture the flag here
      if (!currentPrompt) {
        const finalMessage = "Thank you for your responses! Goodbye.";
        conversationHistory.push({ role: "assistant", content: finalMessage });
        console.log("[INFO] Conversation Complete. Final Message Sent.");
        return new Response(finalMessage, { status: 200 });
      }
  
      // Figure out if the current prompt actually requires validation
      const promptValidation = PROMPT_LIST[currentIndex]?.validation;
      const promptValidationNeeded =
        (typeof promptValidation === "boolean" && promptValidation === true) ||
        (typeof promptValidation === "string");
  
      const isAutoTransitionHidden = PROMPT_LIST[currentIndex]?.autoTransitionHidden || false;
      const isAutoTransitionVisible = PROMPT_LIST[currentIndex]?.autoTransitionVisible || false;
  
      console.log("\n[DEBUG] Current Prompt:\n", currentPrompt);
      console.log("[DEBUG] Checking prompt validation property:", promptValidation);
      console.log("[DEBUG] Validation needed?", promptValidationNeeded);
      console.log("[DEBUG] AutoTransitionHidden Status:", isAutoTransitionHidden);
      console.log("[DEBUG] AutoTransitionVisible Status:", isAutoTransitionVisible);
  
      // 1) Insert the system prompt
      conversationHistory = [
        { role: "system", content: currentPrompt },
        ...conversationHistory.filter((entry) => entry.role !== "system"),
      ];
      console.log(
        "[DEBUG] Updated Conversation History (System Prompt First):\n",
        JSON.stringify(conversationHistory, null, 2)
      );
  
      // 2) Add user message
      conversationHistory.push({ role: "user", content: userMessage });
      console.log("[DEBUG] Adding User Input to Conversation History.");
  
      // 3) Manage buffer
      conversationHistory = manageBuffer(conversationHistory);
  
      // 4) If validation is needed, do it (but do not increment currentIndex yet)
      if (promptValidationNeeded) {
        console.log("[INFO] This prompt has validation: Checking user input now...");
        const customValidation =
          typeof promptValidation === "string" ? promptValidation : undefined;
        const isValid = await validateInput(userMessage, currentPrompt, customValidation);
        if (!isValid) {
          console.log("[INFO] Validation Failed. Retrying the Same Prompt.");
          const retryMsg = await generateRetryMessage(userMessage, currentPrompt);
          conversationHistory.push({ role: "assistant", content: retryMsg });
          conversationHistory = manageBuffer(conversationHistory);
          return new Response(retryMsg, { status: 200 });
        }
        console.log("[INFO] Validation Succeeded.");
      } else {
        console.log("[INFO] No validation property found. Skipping validation check.");
      }
      // (Notice: currentIndex is not incremented here.)
  
      // 5) Build LLM payload using the current prompt
      const mainPayload = {
        model: "llama-3.1-8b-instant",
        temperature: 0,
        messages: conversationHistory,
      };
      console.log("[DEBUG] Main Payload to LLM:\n", JSON.stringify(mainPayload, null, 2));
  
      const mainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(mainPayload),
      });
      if (!mainResp.ok) {
        const errorText = await mainResp.text();
        console.error("[ERROR] LLM call failed:\n", errorText);
        return new Response("I'm sorry, I couldn't process that. Please try again.", { status: 200 });
      }
      const mainData = await mainResp.json();
      const assistantContent1 = mainData.choices?.[0]?.message?.content;
      if (!assistantContent1) {
        return new Response("No content returned from the LLM. Please try again.", { status: 200 });
      }
  
      /*********************************************
       * ADDED DEBUG: Log the raw assistant response
       *********************************************/
      console.log("[DEBUG] assistantContent1 from LLM:", assistantContent1);
  
      // 6) Add new assistant content to conversation history
      conversationHistory.push({ role: "assistant", content: assistantContent1 });
      console.log("[DEBUG] First API Response Added to Conversation History.");
  
      // ***** START ADDED CODE *****
      // Use the stored flag for the current prompt to decide if we insert important memory.
      if (thisPromptImportant) {
        insertImportantMemory(assistantContent1);
      }
      // ***** END ADDED CODE *****
  
      // 7) Manage buffer again
      conversationHistory = manageBuffer(conversationHistory);
  
      // 8) Now that we’ve processed the current prompt fully, increment currentIndex.
      currentIndex++;
  
      // 9) Overwrite system with the new prompt
      const newPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
      console.log("[DEBUG] Next Prompt is now:", newPrompt);
      conversationHistory = [
        { role: "system", content: newPrompt },
        ...conversationHistory.filter((entry) => entry.role !== "system"),
      ];
  
      // 10) Possibly chain
      let finalChained: string | null = null;
      if (PROMPT_LIST[currentIndex]?.chaining) {
        finalChained = await chainIfNeeded(assistantContent1);
      }
  
      // 11) Auto-Transition Hidden
      if (PROMPT_LIST[currentIndex]?.autoTransitionHidden) {
        console.log("[DEBUG - AUTO-HIDDEN] autoTransitionHidden = true. Entering loop...");
        let autoResponses: string[] = [];
        while (
          currentIndex < PROMPT_LIST.length &&
          PROMPT_LIST[currentIndex]?.autoTransitionHidden
        ) {
          console.log("[DEBUG - AUTO-HIDDEN] Next prompt also autoTransitionHidden, continuing...");
          const { conversationHistory: updatedConv, response: autoResponse, updatedIndex } =
            await handleAutoTransitionHidden(conversationHistory, currentIndex);
          conversationHistory = updatedConv;
          currentIndex = updatedIndex;
          autoResponses.push(autoResponse);
        }
        const finalVisible = autoResponses[autoResponses.length - 1] || (finalChained || assistantContent1);
        for (let i = 0; i < autoResponses.length - 1; i++) {
          console.log("[DEBUG] Hidden text NOT returned to user:", autoResponses[i]);
        }
        console.log("[DEBUG] Final text returned to user:", finalVisible);
        return new Response(finalVisible, { status: 200 });
      }
  
      // 12) Auto-Transition Visible
      if (PROMPT_LIST[currentIndex]?.autoTransitionVisible) {
        console.log("[DEBUG - AUTO-VISIBLE] autoTransitionVisible = true. Entering loop...");
        let combinedVisible = finalChained || assistantContent1;
        while (
          currentIndex < PROMPT_LIST.length &&
          PROMPT_LIST[currentIndex]?.autoTransitionVisible
        ) {
          console.log("[DEBUG - AUTO-VISIBLE] Next prompt also autoTransitionVisible, continuing...");
          const { conversationHistory: updatedConv, response: autoResponse, updatedIndex } =
            await handleAutoTransitionVisible(conversationHistory, currentIndex);
          conversationHistory = updatedConv;
          currentIndex = updatedIndex;
          if (!autoResponse) {
            console.log("[DEBUG] Final text returned to user:", combinedVisible);
            return new Response(combinedVisible, { status: 200 });
          }
          combinedVisible += "\n\n" + autoResponse;
        }
        console.log("[DEBUG] Final text returned to user:", combinedVisible);
        return new Response(combinedVisible, { status: 200 });
      }
  
      // 13) If no auto-transition, just return final
      console.log("[DEBUG] Final text returned to user:", finalChained || assistantContent1);
      return new Response(finalChained || assistantContent1, { status: 200 });
  
    } catch (error: any) {
      console.error("[ERROR] in POST handler:\n", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }
  