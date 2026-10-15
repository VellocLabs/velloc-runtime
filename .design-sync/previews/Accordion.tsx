import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "chromium-runtime";

export const Single = () => (
  <div style={{ padding: 16, width: 440 }}>
    <Accordion type="single" collapsible defaultValue="item-1">
      <AccordionItem value="item-1">
        <AccordionTrigger>What is Nexus?</AccordionTrigger>
        <AccordionContent>
          A Chromium-based browser with a built-in agent panel that designs and
          builds with your real components.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-2">
        <AccordionTrigger>Which models are supported?</AccordionTrigger>
        <AccordionContent>
          Claude Opus, Sonnet, and Haiku, plus any configurable provider.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="item-3">
        <AccordionTrigger>Where are sessions stored?</AccordionTrigger>
        <AccordionContent>
          Locally, under your profile's .velloc directory.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  </div>
);
