// Import the SpeechRecognitionService
import SpeechRecognitionService from './services/SpeechRecognitionService';
import TTSService from './services/TTSService'; // Import TTSService
import { SpeechManagerConfig, SpeechCallback, UIElements, SpeechState } from './types';

// Add a simple Toast class
class Toast {
    private element: HTMLDivElement;
    private readonly TOAST_DURATION = 3000; // 3 seconds
    
    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'stt-toast';
        this.element.style.display = 'none';
        document.body.appendChild(this.element);
    }
    
    show(message: string, type: 'error' | 'info' = 'info'): void {
        this.element.textContent = message;
        this.element.className = `stt-toast ${type}`;
        this.element.style.display = 'block';
        
        setTimeout(() => {
            this.element.style.display = 'none';
        }, this.TOAST_DURATION);
    }
}

class SpeechToTextManager {
    private readonly MAX_RETRIES = 5;
    private readonly INITIAL_RETRY_DELAY = 500;
    private readonly MIC_BUTTON_ID = 'speech-to-text-button';
    private speechService: SpeechRecognitionService;
    private elements: UIElements = {
        textArea: null,
        displayElement: null,
        micButton: null,
        interimDisplay: null
    };
    private state: SpeechState = {
        isListening: false,
        previousText: '',
        lastStopTime: 0
    };
    private lastKnownPosition: number = 0;

    // Game state variables
    private gameActive: boolean = false;
    private playerCharacter: string | null = null;
    private gameStartTime: number = 0;
    private currentStorySegment: string = "";
    private availableChoices: string[] = [];
    private choiceFormatCounter: number = 0; // For varying choice formats A/B, A/B/C, Numerical
    private ttsService: TTSService; // Use TTSService type
    private expectingCharacterChoice: boolean = false; // New state to track if we are waiting for character choice
    private chatGPTResponseObserver: MutationObserver | null = null;
    private lastProcessedMessageId: string | null = null; // To avoid processing the same message multiple times
    private gameTimerIntervalId: number | null = null;
    private halfwayWarningGiven: boolean = false;
    private approachingDenouement: boolean = false; // To signal prompts to guide AI to a conclusion

    private updateText(finalText: string, interimText: string): void {
        if (this.expectingCharacterChoice) {
            this.processCharacterChoice(finalText.trim());
            return;
        }

        // If game is active, player input should be handled by game logic
        if (this.gameActive) { // Note: expectingCharacterChoice is handled before this block
            this.processPlayerGameChoice(finalText.trim());
            return;
        }

        // Fallback to original behavior if not in game context (e.g. if game hasn't started or is over)
        // This part might be removed if the extension is purely for the game.
        if (!this.elements.textArea || !this.elements.interimDisplay) {
            // If text area isn't found (e.g. during initial game setup before UI is ready for text input)
            // we might not want to do anything here or log a specific message.
            // For now, let's assume it might not be an error if game is starting.
            if(!this.gameActive && !this.expectingCharacterChoice) {
                console.log("Textarea not found, but not in active game or expecting choice. Input:", finalText);
            }
            return;
        }

        // Get the current selection
        const selection = window.getSelection();
        const range = selection?.getRangeAt(0);

        // If we have a valid selection within the text area
        if (selection && range && this.elements.textArea.contains(range.commonAncestorContainer)) {
            // Store the current position
            this.lastKnownPosition = range.startOffset;

            // Insert text at the current selection
            range.deleteContents();
            range.insertNode(document.createTextNode(finalText));

            // Move cursor to end of inserted text
            range.setStartAfter(range.endContainer);
            range.setEndAfter(range.endContainer);
            selection.removeAllRanges();
            selection.addRange(range);
        } else {
            // If no valid selection, append to the end
            const textNode = document.createTextNode(finalText);
            this.elements.textArea.appendChild(textNode);

            // Move cursor to end of inserted text
            const newRange = document.createRange();
            newRange.setStartAfter(textNode);
            newRange.setEndAfter(textNode);
            selection?.removeAllRanges();
            selection?.addRange(newRange);
        }

        // Trigger input event
        const inputEvent = new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: finalText
        });
        this.elements.textArea.dispatchEvent(inputEvent);

        // Update interim display
        if (interimText) {
            this.elements.interimDisplay.textContent = interimText;
            this.elements.interimDisplay.style.display = 'block';
        } else {
            this.elements.interimDisplay.style.display = 'none';
        }
    }

    private toggleSpeech = (event: Event): void => {
        event.preventDefault();
        if (this.state.isListening) {
            this.stopListening();
        } else {
            this.startListening();
        }
    }

    private async startListening(): Promise<void> {
        if (!this.speechService) return;

        try {
            this.state.isListening = true;
            await this.speechService.start();
            this.elements.micButton?.classList.add('active');
        } catch (error) {
            this.state.isListening = false;
            this.elements.micButton?.classList.remove('active');
            // Show error toast or notification
        }
    }

    private stopListening = (): void => {
        if (!this.speechService) return;

        this.state.isListening = false;
        this.state.lastStopTime = Date.now();
        this.elements.micButton?.classList.remove('active');
        this.elements.micButton?.classList.remove('speaking');
        this.speechService.stop();

        if (this.elements.interimDisplay) {
            this.elements.interimDisplay.style.display = 'none';
        }
        this.lastKnownPosition = 0;
    }

    private handleError = (message: string): void => {
        // Remove active state and stop listening
        this.stopListening();

        // Show error message to user
        const toast = new Toast();
        toast.show(message, 'error');
    }

    private handleMicActivity = (isActive: boolean): void => {
        if (!this.elements.micButton) return;

        if (isActive) {
            this.elements.micButton.classList.add('speaking');
        } else {
            this.elements.micButton.classList.remove('speaking');
        }
    }

    constructor() {
        const config: SpeechManagerConfig = {
            language: 'en-US',
            continuous: true,
            interimResults: true,
            onMicActivity: this.handleMicActivity,
            onEnd: () => this.stopListening(),
            onError: this.handleError
        };

        this.speechService = new SpeechRecognitionService(
            config,
            this.updateText.bind(this)
        );
        // this.initialize(); // Original initialization
        this.startGameInitialization(); // New game initialization
    }

    private async startGameInitialization(): Promise<void> {
        console.log("Hollywood Noir: Starting game initialization...");
        // In a real scenario, we would wait for the page to be ready,
        // potentially show a "Start Game" button or activate on plugin icon click.
        // For now, we'll directly proceed to playing the introduction.

        this.ttsService = new TTSService(); // Instantiate real TTSService

        // Stop any residual speech from previous sessions/reloads
        this.ttsService.stop();

        await this.playIntroduction();
        this.initChatGPTResponseObserver(); // Initialize the observer
    }

    private async playIntroduction(): Promise<void> {
        console.log("Hollywood Noir: Playing introduction...");
        const introText = "Welcome to Hollywood Noir. Do you wish to play as Philip Marlowe, the famous detective, or a more anonymous gumshoe? Say 'Philip Marlowe' or 'Anonymous Detective'. This is an audio-only game. You have 40 minutes to solve the mystery.";

        this.ttsService.speak(introText, () => {
            console.log("Hollywood Noir: Introduction finished. Listening for character choice...");
            this.expectingCharacterChoice = true;
            if (!this.state.isListening && !this.ttsService.isSpeaking()) {
                 this.startListening().catch(e => console.error("Error starting to listen for character choice:", e));
            }
        });
    }

    private processCharacterChoice(choiceText: string): void {
        const normalizedChoice = choiceText.toLowerCase().replace(/[^a-z0-9\s]/gi, '');
        console.log(`Hollywood Noir: Processing character choice - "${normalizedChoice}"`);

        if (normalizedChoice.includes("philip marlowe") || normalizedChoice.includes("philip marlo")) {
            this.playerCharacter = "Philip Marlowe";
        } else if (normalizedChoice.includes("anonymous detective") || normalizedChoice.includes("anonymous gumshoe") || normalizedChoice.includes("anonymous")) {
            this.playerCharacter = "Anonymous Detective";
        } else {
            const retryMessage = "Sorry, I didn't catch that. Please say 'Philip Marlowe' or 'Anonymous Detective'.";
            this.ttsService.speak(retryMessage, () => {
                if (!this.state.isListening && !this.ttsService.isSpeaking()) {
                    this.startListening().catch(e => console.error("Error restarting listening for character choice:", e));
                }
            });
            return;
        }

        this.expectingCharacterChoice = false;
        this.gameActive = true;
        this.gameStartTime = Date.now();
        this.halfwayWarningGiven = false; // Reset flag
        this.approachingDenouement = false; // Reset flag

        // Ensure mic interface elements are ready for submitting prompts
        // This was missing from the original plan but it's important from previous steps
        this.setupMicInterface().then(() => {
            console.log(`Hollywood Noir: Character selected - ${this.playerCharacter}. Game started at ${this.gameStartTime}.`);
            this.startGameTimer(); // Start the game timer
            this.ttsService.speak(`You've chosen to play as ${this.playerCharacter}. The city's shadows await.`, () => {
                this.sendGamePromptToChatGPT("Start the Hollywood Noir game. The player is ready.");
            });
        }).catch(error => {
            console.error("Hollywood Noir: Error setting up mic interface before starting game.", error);
            this.ttsService.speak("There was an issue setting up. Please reload and try again.", () => {
                this.gameActive = false; // Can't proceed
            });
        });
    }

    private startGameTimer(): void {
        if (this.gameTimerIntervalId) {
            clearInterval(this.gameTimerIntervalId);
        }
        console.log("Hollywood Noir: Starting game timer.");
        // Using window.setInterval for clarity with NodeJS types vs browser types
        this.gameTimerIntervalId = window.setInterval(() => {
            if (!this.gameActive) {
                this.stopGameTimer();
                return;
            }

            const elapsedTimeMs = Date.now() - this.gameStartTime;
            const elapsedMinutes = Math.floor(elapsedTimeMs / (60 * 1000));

            // Halfway warning (around 20 minutes)
            if (elapsedMinutes >= 20 && !this.halfwayWarningGiven) {
                this.halfwayWarningGiven = true;
                const halfwayMessage = "You're halfway through the game, with 20 minutes remaining.";
                console.log("Hollywood Noir: Triggering halfway warning.");

                const wasListening = this.state.isListening;
                const ttsWasSpeaking = this.ttsService.isSpeaking();
                if (wasListening) this.stopListening();
                if (ttsWasSpeaking) this.ttsService.stop(); // Stop current TTS to prioritize warning

                this.ttsService.speak(halfwayMessage, () => {
                    // Try to resume listening only if it was active and TTS is now done
                    if (wasListening && !this.state.isListening && !this.ttsService.isSpeaking()) {
                        this.startListening().catch(e => console.error("Error resuming listening after halfway warning:", e));
                    }
                    // If TTS was speaking something else, we don't automatically resume that prior speech.
                });
            }

            // Approaching denouement (around 35 minutes)
            if (elapsedMinutes >= 35 && !this.approachingDenouement) {
                this.approachingDenouement = true;
                console.log("Hollywood Noir: Approaching denouement time. Prompts will now guide AI to a conclusion.");
                // This flag will be used by sendGamePromptToChatGPT in a later step
            }

            // Time's up (40 minutes)
            if (elapsedMinutes >= 40) {
                console.log("Hollywood Noir: Time's up!");
                this.endGame("Time's up, detective. The case runs cold... for now. Game over.");
            }
        }, 30 * 1000); // Check every 30 seconds
    }

    private stopGameTimer(): void {
        if (this.gameTimerIntervalId) {
            clearInterval(this.gameTimerIntervalId);
            this.gameTimerIntervalId = null;
            console.log("Hollywood Noir: Game timer stopped.");
        }
    }

    // Centralized function to end the game
    private endGame(endMessage: string): void {
        if (!this.gameActive && !this.expectingCharacterChoice) { // Avoid multiple calls or if already ended
            console.log("Hollywood Noir: Game already ended or not active.");
            return;
        }
        console.log("Hollywood Noir: Ending game - ", endMessage);
        this.stopGameTimer();
        this.ttsService.stop();
        this.stopListening();
        this.gameActive = false;
        this.expectingCharacterChoice = false; // Reset this too

        // Disconnect observer if it exists
        if (this.chatGPTResponseObserver) {
            this.chatGPTResponseObserver.disconnect();
            this.chatGPTResponseObserver = null;
            console.log("Hollywood Noir: MutationObserver disconnected.");
        }

        this.ttsService.speak(endMessage, () => {
            // Reset flags
            this.halfwayWarningGiven = false;
            this.approachingDenouement = false;
            this.currentStorySegment = "";
            this.availableChoices = [];
            this.lastProcessedMessageId = null;
            // Consider resetting UI if visual suppression was very aggressive
            this.injectStyles(); // Re-inject styles to remove game-active suppression
        });
    }


    private async findTextarea(): Promise<HTMLTextAreaElement | null> {
        // This is a simplified version of the original waitForTextArea
        // In a full implementation, we might need the retry logic from waitForTextArea
        const textarea = document.querySelector('#prompt-textarea'); // Using simpler selector for now
        if (textarea) {
            this.elements.textArea = textarea as HTMLTextAreaElement;
            return this.elements.textArea;
        }
        console.error("Hollywood Noir: ChatGPT textarea not found.");
        return null;
    }

    private async submitToChatGPT(prompt: string): Promise<void> {
        const textarea = await this.findTextarea();
        if (!textarea) {
            this.ttsService.speak("There was a problem communicating with the story engine. Please try reloading the page.", () => {});
            this.gameActive = false; // Stop the game if we can't interact
            return;
        }

        // Simulate user input more closely
        textarea.focus();
        textarea.value = prompt; // Directly set value
        const inputEvent = new Event('input', { bubbles: true, cancelable: true });
        textarea.dispatchEvent(inputEvent);

        // Find and click the send button
        // This selector might need adjustment based on ChatGPT's current UI
        const sendButton = document.querySelector('button[data-testid="send-button"], button.absolute');
        if (sendButton && sendButton instanceof HTMLButtonElement) {
            sendButton.click();
            console.log("Hollywood Noir: Prompt submitted to ChatGPT.");
        } else {
            console.error("Hollywood Noir: Send button not found.");
            this.ttsService.speak("I couldn't send your choice to the story engine. Please check the page.", () => {});
        }
    }

    private sendGamePromptToChatGPT(playerActionOrInstruction: string): void {
        // This is where prompts to ChatGPT are formulated.
        // It will become more complex as we add story context, choice formatting, etc.

        // Basic prompt structure for now
        const prompt = `You are the narrator for "Hollywood Noir", an audio-only game. Maintain a Raymond Chandler style (hardboiled, romantic tension, implied violence, sexual scenarios without graphic depiction). The player is ${this.playerCharacter}. The game has a 40-minute time limit. Current game time: ${Math.floor((Date.now() - this.gameStartTime) / 60000)} minutes.

        Player's previous action/choice result: ${this.currentStorySegment || "This is the beginning of the game."}

        Instruction for this turn: ${playerActionOrInstruction}

        Narrate the next part of the story.
        Based on a counter (${this.choiceFormatCounter}), format your choices as follows:
        - If counter % 10 is 0 (roughly every 10th choice): Provide a numerical choice (e.g., "1) Go to room 301, 2) Check the ledger for room 301").
        - If counter % 5 is 0 (roughly every 5th choice, not overlapping the 10th): Provide 3 lettered choices (A, B, C).
        - Otherwise (most common): Provide 2 lettered choices (A, B).

        Format choices clearly under a "CHOICES:" heading, like:
        CHOICES:
        A) [Choice A text]
        B) [Choice B text]
        (C) [Choice C text, if applicable])
        (1) [Numerical Choice 1 text, if applicable])
        (2) [Numerical Choice 2 text, if applicable])

        Current game time: ${Math.floor((Date.now() - this.gameStartTime) / 60000)} minutes. If approaching 35-40 minutes, guide the story towards a denouement. It is currently ${this.approachingDenouement ? '' : 'not '}time to guide towards a denouement.
        `;
        // Note: Added approachingDenouement info to the prompt.

        console.log("Hollywood Noir: Sending prompt to ChatGPT ->", prompt);
        this.submitToChatGPT(prompt);
    }


    private processPlayerGameChoice(choiceText: string): void {
        if (this.state.isListening) {
            this.stopListening(); // Stop listening as soon as a choice is being processed
        }
        console.log(`Hollywood Noir: Player game choice received - "${choiceText}"`);

        const normalizedChoice = choiceText.toLowerCase().trim();
        if (["end game", "quit game", "stop game", "end the game", "quit the game", "stop the game"].includes(normalizedChoice)) {
            this.endGame("You've decided to call it a night. The city can be a tough place. Game over.");
            return;
        }

        // Basic choice mapping (can be significantly improved)
        // This is a placeholder for a more robust system.
        let mappedChoice = choiceText; // Default to raw text
        const choicePattern = /^(option|choice|number)?\s*([a-d]|[1-4])(\s|$|\.)/i; // "Option A", "A", "1"
        const match = normalizedChoice.match(choicePattern);

        if (match && this.availableChoices.length > 0) {
            const choiceKey = match[2].toUpperCase(); // A, B, C, D, 1, 2, 3, 4
            let choiceIndex = -1;
            if (/[A-D]/.test(choiceKey)) {
                choiceIndex = choiceKey.charCodeAt(0) - 'A'.charCodeAt(0);
            } else if (/[1-4]/.test(choiceKey)) {
                choiceIndex = parseInt(choiceKey, 10) - 1;
            }

            if (choiceIndex >= 0 && choiceIndex < this.availableChoices.length) {
                mappedChoice = this.availableChoices[choiceIndex];
                console.log(`Hollywood Noir: Mapped choice "${choiceText}" to "${mappedChoice}"`);
            } else {
                console.log(`Hollywood Noir: Choice "${choiceText}" (parsed as ${choiceKey}) out of bounds for available choices.`);
                // Keep raw text, maybe TTS a "didn't understand choice, trying anyway"
            }
        }


        // Increment choiceFormatCounter for the *next* set of choices ChatGPT will generate
        this.choiceFormatCounter++;

        const processedChoiceForPrompt = `Player chose: "${mappedChoice}".`;

        this.sendGamePromptToChatGPT(processedChoiceForPrompt);

        // Clear choices and wait for ChatGPT's new response and choices
        this.availableChoices = [];
    }

    // ... (keep existing createInterimDisplay, initialize, waitForTextArea methods for now,
    // they might be needed if we add back some UI or for reference)
    // We need to ensure initialize() is not breaking anything if it's not called.
    // The original initialize() was for setting up the mic button in ChatGPT's UI.
    // For an audio-only game, this might not be necessary once the game starts.

    private createInterimDisplay(): HTMLDivElement {
        const interim = document.createElement('div');
        interim.id = 'interim-display';
        interim.className = 'interim-results';
        return interim;
    }

    // Original initialize, modified to be callable if needed, but not by default in constructor
    private async setupMicInterface(): Promise<void> {
        try {
            await this.waitForTextArea(); // This ensures elements.textArea is set
            this.elements.micButton = this.createMicButton();
            this.elements.interimDisplay = this.createInterimDisplay();

            const textAreaContainer = this.elements.textArea?.parentElement;
            if (textAreaContainer) {
                textAreaContainer.style.position = 'relative';
                textAreaContainer.appendChild(this.elements.interimDisplay);
            }
            // The mic button adding logic (addMicButtonToTextArea) might not be needed if game is fully audio
            // but keeping setupEventListeners for keyboard shortcuts.
            this.setupEventListeners();
            this.injectStyles(); // Styles for mic button, toast, etc.
        } catch (error) {
            console.error("Error setting up mic interface:", error);
            // Handle initialization error
        }
    }

    private async waitForTextArea(retryCount = 0): Promise<void> {
        // Simplified selector, adjust if needed. The original used '#prompt-textarea.ProseMirror'
        const textarea = document.querySelector('#prompt-textarea');
        if (textarea) {
            this.elements.textArea = textarea as HTMLTextAreaElement;
            console.log('Textarea found:', this.elements.textArea);
            return;
        }

        if (retryCount >= this.MAX_RETRIES) {
            console.error('Failed to find textarea after maximum retries');
            throw new Error('Failed to find textarea after maximum retries');
        }

        const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
        console.log(`Textarea not found. Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${this.MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.waitForTextArea(retryCount + 1);
    }

    private initChatGPTResponseObserver(): void {
        if (this.chatGPTResponseObserver) {
            this.chatGPTResponseObserver.disconnect();
        }

        // More robust selector for ChatGPT message bubbles.
        // This typically involves a parent container and then individual messages.
        // The exact selector can change with UI updates. This is a common pattern:
        // Look for elements with 'data-message-id' or similar, often within a 'group' or 'role' attribute.
        // Let's assume messages are within a div that groups them, e.g., a scrollable area.
        // And each message has a specific structure.
        // For now, a simpler approach: find the main chat container.
        const chatContainerSelector = 'main .flex-1 .group'; // This is a guess, needs verification
        const targetNode = document.querySelector('main .flex-1') || document.body; // Fallback to body

        console.log("Hollywood Noir: Setting up MutationObserver on target:", targetNode);

        this.chatGPTResponseObserver = new MutationObserver((mutationsList) => {
            if (!this.gameActive) return;

            for (const mutation of mutationsList) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const element = node as Element;
                            // Try to find a new message from ChatGPT.
                            // ChatGPT messages often have a specific structure or data attributes.
                            // Example: Look for a div with role="assistant" or similar unique attribute.
                            // This selector will likely need to be specific to ChatGPT's current DOM structure.
                            // Let's assume a message from the assistant has a specific data attribute or class.
                            // For example, `div[data-message-author-role="assistant"]`
                            // And that it contains child elements with the actual text.
                            // We also need to make sure it's a *new* message.

                            // A common pattern is that the last message from the assistant is what we want.
                            // We need to avoid re-processing our own input or old messages.
                            // Query for elements that look like assistant messages within the added node or its children.
                            const assistantMessages = element.querySelectorAll('div[data-message-author-role="assistant"]');
                            assistantMessages.forEach(msgElement => {
                                const messageId = msgElement.getAttribute('data-message-id'); // Assuming messages have IDs

                                if (messageId && messageId === this.lastProcessedMessageId) {
                                    return; // Already processed this message
                                }

                                // Check if it's the last message in the thread to avoid picking up old ones during load
                                const allAssistantMessages = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"]'));
                                if (allAssistantMessages.length > 0 && allAssistantMessages[allAssistantMessages.length - 1] !== msgElement) {
                                    // This isn't the latest message, might be an old one rendering.
                                    // This check might be too aggressive if parts of a message stream in.
                                    // console.log("Skipping non-latest assistant message:", msgElement);
                                    // return;
                                }


                                // Extract text content - this might need to be more sophisticated
                                // to combine multiple text nodes or handle complex formatting.
                                // Often, message content is within a specific child div.
                                const textContentDiv = msgElement.querySelector('.markdown') || msgElement; // Common class for content
                                let text = textContentDiv.textContent || "";
                                text = text.trim();

                                if (text && messageId !== this.lastProcessedMessageId) {
                                    console.log("Hollywood Noir: Detected new ChatGPT response:", text.substring(0, 100) + "...");
                                    this.lastProcessedMessageId = messageId;
                                    this.handleChatGPTResponse(text);
                                    // Break if we found and processed a message to avoid multiple triggers from one event
                                    return;
                                }
                            });
                        }
                    });
                }
                // Sometimes messages are updated in place (e.g. streaming text)
                // This is more complex to handle for TTS, as we'd want to wait for the full message.
                // For now, we primarily focus on addedNodes.
            }
        });

        this.chatGPTResponseObserver.observe(targetNode, { childList: true, subtree: true });
        console.log("Hollywood Noir: MutationObserver started.");
    }

    private handleChatGPTResponse(responseText: string): void {
        if (this.ttsService.isSpeaking()) {
            this.ttsService.stop(); // Stop any previous speech
        }

        this.currentStorySegment = responseText; // Store the full response

        // Basic parsing for choices (Can be improved significantly)
        const choiceRegex = /CHOICES:\s*([\s\S]*)/i;
        const choiceMatch = responseText.match(choiceRegex);
        let narrative = responseText;
        let choiceLines: string[] = [];

        if (choiceMatch && choiceMatch[1]) {
            narrative = responseText.substring(0, choiceMatch.index).trim();
            const choicesBlock = choiceMatch[1].trim();
            // Regex to find A) B) 1. 2. etc.
            const individualChoiceRegex = /^\s*([A-Z0-9]+[).\s]+)([^-\n]+(?:-[^-\n]+)*)/gm;
            let match;
            this.availableChoices = [];
            let parsedChoicesForTTS = "Your choices are: ";
            let foundChoices = false;

            while ((match = individualChoiceRegex.exec(choicesBlock)) !== null) {
                foundChoices = true;
                const choiceLabel = match[1].trim().replace(/[.)\s]+$/, ''); // A, B, 1, 2
                const choiceText = match[2].trim();
                this.availableChoices.push(choiceText); // Store the actual choice text
                parsedChoicesForTTS += `${choiceLabel}. ${choiceText}. `;
            }
            if(!foundChoices) { // If CHOICES: block is empty or malformed
                 parsedChoicesForTTS = "No specific choices were provided by the narrator. What do you do?";
            }
             choiceLines.push(parsedChoicesForTTS);

        } else {
            this.availableChoices = []; // No choices found
            narrative += " What do you do next?"; // Prompt player if no choices given
        }

        console.log("Hollywood Noir: Narrative - ", narrative);
        console.log("Hollywood Noir: Available Choices - ", this.availableChoices);
        console.log("Hollywood Noir: Choices for TTS - ", choiceLines.join(" "));

        this.ttsService.speak(narrative, () => {
            // Check for game end keywords in the narrative
            const upperNarrative = narrative.toUpperCase();
            const endKeywords = ["THE END", "CASE CLOSED", "MYSTERY SOLVED"];
            let gameConcludedByNarrative = false;
            for (const keyword of endKeywords) {
                if (upperNarrative.includes(keyword)) {
                    gameConcludedByNarrative = true;
                    break;
                }
            }

            if (gameConcludedByNarrative) {
                console.log("Hollywood Noir: Game conclusion detected in narrative.");
                // The narrative itself is the concluding message.
                // endGame method will handle TTS stop, listening stop, timer stop etc.
                // We call endGame *after* this current narrative has finished speaking.
                this.endGame(narrative); // Pass the narrative as the end message.
            } else if (choiceLines.length > 0) {
                this.ttsService.speak(choiceLines.join(" "), () => {
                    // After choices are spoken, listen for player's next input
                    if (this.gameActive && !this.state.isListening && !this.ttsService.isSpeaking()) {
                        this.startListening().catch(e => console.error("Error starting listening after choices:", e));
                    }
                });
            } else {
                 // If no choices, and game not ended by narrative, still listen for player's next input
                if (this.gameActive && !this.state.isListening && !this.ttsService.isSpeaking()) {
                    this.startListening().catch(e => console.error("Error starting listening after narrative (no choices):", e));
                }
            }
        });
    }

    // public initMutationObserver(): void { // Original observer for mic button
    //     const observer = new MutationObserver((mutations) => {
    //         const shouldAddMic = mutations.some(mutation =>
    //             mutation.type === 'childList' &&
    //             mutation.addedNodes.length > 0 &&
    //             !document.querySelector(`#${this.MIC_BUTTON_ID}`) &&
    //             document.getElementById('prompt-textarea')
    //         );

    //         if (shouldAddMic) {
    //             this.addMicButtonToTextArea();
    //         }
    //     });

    //     observer.observe(document.body, {
    //         childList: true,
    //         subtree: true
    //     });
    // }

    private createMicButton(): HTMLButtonElement {
        const button = document.createElement('button');
        button.id = this.MIC_BUTTON_ID;
        button.className = 'flex h-9 min-w-8 items-center justify-center rounded-full border p-2 text-[13px] font-medium text-token-text-secondary border-token-border-light hover:bg-token-main-surface-secondary';
        button.type = 'button';
        button.setAttribute('aria-label', 'Toggle speech to text');

        // Create the mic icon with specific size
        const micIcon = document.createElement('img');
        micIcon.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJsdWNpZGUgbHVjaWRlLW1pYyI+PHBhdGggZD0iTTEyIDJhMyAzIDAgMCAwLTMgM3Y3YTMgMyAwIDAgMCA2IDBWNWEzIDMgMCAwIDAtMy0zWiIvPjxwYXRoIGQ9Ik0xOSAxMHYyYTcgNyAwIDAgMS0xNCAwdi0yIi8+PHBhdGggZD0iTTEyIDE5di00Ii8+PC9zdmc+'; // Base64 encoded SVG mic icon
        micIcon.alt = 'Microphone';
        micIcon.style.width = '18px';
        micIcon.style.height = '18px';
        micIcon.style.filter = this.isLightMode() ? 'brightness(0.4)' : 'none'; // Make icon darker in light mode
        button.appendChild(micIcon);

        button.addEventListener('click', this.toggleSpeech);
        return button;
    }

    private setupEventListeners(): void {
        // Add keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this.toggleSpeech(e);
            }
        });
    }

    private isLightMode(): boolean {
        // Check if html element has dark class
        return !document.documentElement.classList.contains('dark');
    }

    private injectStyles(): void {
        // Create a style element directly instead of loading from chrome
        const style = document.createElement('style');
        const buttonId = this.MIC_BUTTON_ID;

        // Basic visual suppression for audio-only game
        // These selectors are generic and might need refinement based on ChatGPT's UI
        // The goal is to hide the main chat interface to encourage audio-only interaction
        const visualSuppressionStyles = `
            /* Try to hide the main chat transcript area */
            main .flex-1.overflow-hidden {
                /* display: none !important; */ /* This might be too aggressive, could break observer */
                opacity: 0.1 !important; /* Make it very faint */
                pointer-events: none !important; /* Disable interaction */
            }

            /* Try to hide the text input area, but we still need it programmatically */
            #prompt-textarea {
                 /* opacity: 0.1 !important; */ /* Don't hide the textarea itself, we need it */
                 /* pointer-events: none !important; */
            }
            form /* the form around the textarea */ {
                 opacity: 0.1 !important;
                 pointer-events: none !important;
            }

            /* Hide user's own messages if they appear visually */
            div[data-message-author-role="user"] {
                /* display: none !important; */
                 opacity: 0.1 !important;
                 pointer-events: none !important;
            }
        `;


        style.textContent = `
            ${this.gameActive ? visualSuppressionStyles : ''}

            .stt-toast {
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                padding: 12px 24px;
                background-color: #333;
                color: white;
                border-radius: 4px;
                z-index: 10000;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            }
            
            .stt-toast.error {
                background-color: #d32f2f;
            }
            
            #interim-display {
                position: absolute;
                bottom: 100%;
                left: 0;
                width: 100%;
                color: gray;
                padding: 5px;
                margin-bottom: 5px;
                font-style: italic;
            }
            
            #${buttonId} {
                filter: ${this.isLightMode() ? 'brightness(0.98)' : 'none'};
            }

            #${buttonId}:hover {
                background-color: ${this.isLightMode()
                ? 'rgba(0, 0, 0, 0.07)'
                : 'rgb(64, 65, 79)'};
            }
            
            #${buttonId}.speaking {
                background-color: #10a37f;
                border-color: #10a37f;
            }
            
            #${buttonId}.speaking img {
                filter: brightness(10);
            }
        `;
        document.head.appendChild(style);
    }

    private addMicButtonToTextArea(): void {
        if (!this.elements.textArea || !this.elements.micButton) return;

        // Look for the flex container that holds the action buttons (upload, search, etc.)
        const actionContainer = document.querySelector('.bg-primary-surface-primary .flex.items-center.gap-2');

        if (!actionContainer) {
            console.log('Could not find action container');
            return;
        }

        // Insert after first action button
        const firstAction = actionContainer.firstElementChild;
        if (firstAction) {
            actionContainer.insertBefore(this.elements.micButton, firstAction.nextSibling);
        }
    }

}

(() => {
    const manager = new SpeechToTextManager();
    manager.initMutationObserver();
})();