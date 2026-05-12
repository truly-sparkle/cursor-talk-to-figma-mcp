// BL-028: Prompt registrations split out of server.ts
//
// Each prompt is a long static string. Keeping them inline made server.ts
// >4000 lines and hard to scan. Migration is incremental — `register*`
// functions here grow as prompts are moved out of server.ts.
//
// Pattern: each prompt gets its own register() function that takes the
// MCP server instance and calls `server.prompt(...)`. server.ts imports
// and calls them in one block. Adding a new prompt is two changes:
//   1. New register* function here
//   2. One call in server.ts:registerPrompts()

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// --- design_strategy -----------------------------------------------

const DESIGN_STRATEGY_TEXT = `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`;

function registerDesignStrategy(server: McpServer) {
  server.prompt(
    "design_strategy",
    "Best practices for working with Figma designs",
    () => ({
      messages: [
        {
          role: "assistant",
          content: { type: "text", text: DESIGN_STRATEGY_TEXT },
        },
      ],
      description: "Best practices for working with Figma designs",
    })
  );
}

// --- registerPrompts -----------------------------------------------
// Add new register* calls here as prompts move out of server.ts.

export function registerPrompts(server: McpServer): void {
  registerDesignStrategy(server);
  // Remaining 5 prompts still live in server.ts (read_design_strategy,
  // text_replacement_strategy, annotation_conversion_strategy,
  // swap_overrides_instances, reaction_to_connector_strategy). Migrate
  // incrementally with the same pattern.
}
