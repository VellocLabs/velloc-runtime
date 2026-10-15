import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
} from "chromium-runtime";

export const Default = () => (
  <div style={{ padding: 16, width: 380 }}>
    <Card>
      <CardHeader>
        <CardTitle>Upgrade to Pro</CardTitle>
        <CardDescription>
          Unlock higher rate limits and longer context.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0, fontSize: 14, color: "var(--muted-foreground)" }}>
          Your team is on the Free plan. Pro adds priority access and 1M-token
          context windows across every model.
        </p>
      </CardContent>
      <CardFooter style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost">Maybe later</Button>
        <Button>Upgrade</Button>
      </CardFooter>
    </Card>
  </div>
);
