// src/services/TTSService.ts

class TTSService {
    private synthesis: SpeechSynthesis;
    private currentUtterance: SpeechSynthesisUtterance | null = null;
    private utteranceQueue: { text: string, onEndCallback?: () => void }[] = [];
    private speaking: boolean = false;

    constructor() {
        this.synthesis = window.speechSynthesis;
    }

    public speak(text: string, onEndCallback?: () => void): void {
        if (!text.trim()) {
            if (onEndCallback) onEndCallback();
            return;
        }

        this.utteranceQueue.push({ text, onEndCallback });
        if (!this.speaking) {
            this.processQueue();
        }
    }

    private processQueue(): void {
        if (this.utteranceQueue.length === 0) {
            this.speaking = false;
            return;
        }

        this.speaking = true;
        const { text, onEndCallback } = this.utteranceQueue.shift()!;

        // Cancel any ongoing speech immediately before starting new speech
        if (this.synthesis.speaking) {
            this.synthesis.cancel();
        }

        this.currentUtterance = new SpeechSynthesisUtterance(text);
        this.currentUtterance.lang = 'en-US'; // Or make configurable

        this.currentUtterance.onend = () => {
            console.log("TTSService: Speech finished for - ", text.substring(0, 30) + "...");
            this.currentUtterance = null;
            if (onEndCallback) {
                try {
                    onEndCallback();
                } catch (e) {
                    console.error("TTSService: Error in onEndCallback", e);
                }
            }
            // Brief pause before processing next item to avoid cutting off if called rapidly
            setTimeout(() => this.processQueue(), 50);
        };

        this.currentUtterance.onerror = (event) => {
            console.error('TTSService: SpeechSynthesisUtterance.onerror', event);
            this.currentUtterance = null;
            if (onEndCallback) { // Still call callback, maybe with error?
                try {
                    onEndCallback(); // Or indicate error
                } catch (e) {
                    console.error("TTSService: Error in onEndCallback after speech error", e);
                }
            }
             // Brief pause before processing next item
            setTimeout(() => this.processQueue(), 50);
        };

        // Workaround for Chrome speech synthesis bug where it sometimes doesn't speak
        // or stops after a while. Periodically "pinging" it can help.
        // This specific workaround might not be needed or might need adjustment.
        // For now, let's keep it simple.

        this.synthesis.speak(this.currentUtterance);
    }

    public stop(): void {
        this.utteranceQueue = []; // Clear pending utterances
        if (this.synthesis.speaking) {
            this.synthesis.cancel(); // Stop current speech
        }
        this.speaking = false;
        console.log("TTSService: Speech stopped and queue cleared.");
    }

    public isSpeaking(): boolean {
        return this.speaking || this.synthesis.speaking;
    }
}

export default TTSService;
