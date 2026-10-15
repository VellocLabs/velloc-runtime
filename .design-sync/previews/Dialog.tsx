import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Button,
} from "chromium-runtime";

// Rendered open (controlled `open`) so the modal surface shows in the card.
export const Confirm = () => (
  <Dialog open>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reset all settings?</DialogTitle>
        <DialogDescription>
          This restores every section to its defaults. Your sessions and chat
          history are kept.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button variant="destructive">Reset settings</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
