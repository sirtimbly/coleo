import { useState } from "react";
import { Card, CardContent } from "@/components";

/**
 * Test page for MailPage overflow bug fix
 * 
 * Bug: Long message content overflows its container
 * Fix: Added break-all and min-w-0 to constrain content
 */

const testMessages = [
  {
    id: "1",
    title: "Long URL (no spaces)",
    content:
      "Check out this link: https://example.com/very/long/path/that/should/wrap/correctly/without/overflowing/the/container/boundaries/and/making/the/ui/look/bad",
  },
  {
    id: "2",
    title: "Code snippet",
    content: `const veryLongVariableName = "ThisIsAVeryLongStringWithoutSpacesThatShouldWrapCorrectly";
const anotherLongLine = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua";

function test() {
  return "AnotherVeryLongStringThatNeedsToWrapProperlyWithinTheContainer";
}`,
  },
  {
    id: "3",
    title: "Mixed content",
    content: `Hello!

Here's a long URL: https://github.com/sirtimbly/coleo/pulls/very/long/path/that/needs/to/wrap

And some code: const x = "VeryLongStringWithoutAnySpacesOrBreaksThatShouldStillWrap";

Thanks!`,
  },
  {
    id: "4",
    title: "Normal text (should still work)",
    content:
      "This is normal text with spaces that should wrap naturally at word boundaries. Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  },
];

export function MailOverflowTestPage() {
  const [selectedTest, setSelectedTest] = useState(testMessages[0]);

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-2xl font-bold">Mail Page Overflow Bug - Test Page</h1>

      <div className="grid grid-cols-2 gap-4">
        {/* Test selector */}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Test Cases</h2>
          {testMessages.map((msg) => (
            <button
              type="button"
              key={msg.id}
              onClick={() => setSelectedTest(msg)}
              className={`w-full text-left p-3 rounded border transition-colors ${
                selectedTest.id === msg.id
                  ? "border-accent bg-accent/10"
                  : "border-border hover:border-accent/50"
              }`}
            >
              <div className="font-medium">{msg.title}</div>
            </button>
          ))}
        </div>

        {/* Message display (simulating MailPage thread view) */}
        <div>
          <h2 className="text-lg font-semibold mb-2">Message Display</h2>
          <Card className="max-w-lg">
            <CardContent className="p-4">
              <div className="text-sm text-muted-foreground mb-2">
                {selectedTest.title}
              </div>

              {/* This is the fixed container structure from MailPage.tsx */}
              <div className="min-w-0">
                <pre className="whitespace-pre-wrap break-all text-sm font-mono bg-secondary/30 p-3 rounded overflow-auto max-h-80">
                  {selectedTest.content}
                </pre>
              </div>

              <div className="mt-4 p-3 bg-green-500/10 border border-green-500/30 rounded text-sm">
                <strong>Expected:</strong> Content should wrap and stay within
                the card boundaries. No horizontal overflow.
              </div>
            </CardContent>
          </Card>

          {/* Comparison: Old (broken) version */}
          <div className="mt-6">
            <h3 className="text-md font-semibold mb-2 text-destructive">
              Before Fix (Broken)
            </h3>
            <Card className="max-w-lg border-destructive">
              <CardContent className="p-4">
                <div className="text-sm text-muted-foreground mb-2">
                  {selectedTest.title}
                </div>

                {/* Old broken structure */}
                <div>
                  <pre className="whitespace-pre-wrap text-sm font-mono bg-secondary/30 p-3 rounded overflow-auto max-h-80">
                    {selectedTest.content}
                  </pre>
                </div>

                <div className="mt-4 p-3 bg-destructive/10 border border-destructive/30 rounded text-sm">
                  <strong>Issue:</strong> Long content overflows the card
                  boundaries.
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* CSS explanation */}
      <div className="mt-8 p-4 bg-muted rounded-lg">
        <h2 className="text-lg font-semibold mb-2">Fix Explanation</h2>
        <ul className="list-disc list-inside space-y-1 text-sm">
          <li>
            <code>min-w-0</code> on parent container allows flex items to shrink
            below their content size
          </li>
          <li>
            <code>break-all</code> forces long unbroken strings to wrap at any
            character
          </li>
          <li>
            <code>whitespace-pre-wrap</code> preserves formatting but allows
            wrapping
          </li>
          <li>
            <code>overflow-auto</code> provides fallback scrollbar if needed
          </li>
        </ul>
      </div>
    </div>
  );
}
