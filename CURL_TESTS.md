# FamFin Gateway cURL Tests

Replace:

```text
BASE_URL=https://famfin-ai-gateway.onrender.com
APP_TOKEN=YOUR_FAMFIN_AI_APP_TOKEN
HOUSEHOLD_ID=hh_9f2c41ab
```

## Render health

```bash
curl "$BASE_URL/healthz"
```

## App health

```bash
curl "$BASE_URL/v1/ai/health" \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H "X-FamFin-Client: famfin-app"
```

## Streaming chat

```bash
curl --no-buffer -X POST "$BASE_URL/v1/ai/chat" \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "X-FamFin-Client: famfin-app" \
  -H "X-FamFin-Household: $HOUSEHOLD_ID" \
  -d '{
    "model": "default",
    "stream": true,
    "messages": [
      {"role":"user","content":"How much can I safely spend this month?"}
    ],
    "context": {
      "currency":"INR",
      "monthlyIncome":85000,
      "monthTotalSpend":41200,
      "safeToSpend":12400,
      "protectedAmount":18000
    }
  }'
```

Expected ending:

```text
data: [DONE]
```

## Extract from OCR text

```bash
curl -X POST "$BASE_URL/v1/ai/extract" \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-FamFin-Client: famfin-app" \
  -H "X-FamFin-Household: $HOUSEHOLD_ID" \
  -d '{
    "documentType":"receipt",
    "mimeType":"image/jpeg",
    "extractedText":"RELIANCE FRESH 14/08/26 TOTAL 1,284.50",
    "expectedFields":["merchant","date","totalAmount","currency","category","taxAmount"],
    "hints":{"currency":"INR","locale":"en_IN"}
  }'
```

## Extract from Base64 image

Linux/macOS example:

```bash
BASE64=$(base64 -w 0 receipt.jpg)

curl -X POST "$BASE_URL/v1/ai/extract" \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-FamFin-Client: famfin-app" \
  -H "X-FamFin-Household: $HOUSEHOLD_ID" \
  -d "{\"documentType\":\"receipt\",\"mimeType\":\"image/jpeg\",\"contentBase64\":\"$BASE64\",\"expectedFields\":[\"merchant\",\"date\",\"totalAmount\",\"currency\"]}"
```

## Quota

```bash
curl "$BASE_URL/v1/ai/quota" \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H "X-FamFin-Client: famfin-app" \
  -H "X-FamFin-Household: $HOUSEHOLD_ID"
```

## Feedback

```bash
curl -i -X POST "$BASE_URL/v1/ai/feedback" \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-FamFin-Client: famfin-app" \
  -H "X-FamFin-Household: $HOUSEHOLD_ID" \
  -d '{
    "messageId":"msg_8812",
    "rating":"down",
    "reason":"wrong_number",
    "comment":"Said my net worth included my credit limit."
  }'
```

Expected HTTP status: `204 No Content`.

## Invalid token check

```bash
curl -i "$BASE_URL/v1/ai/health" \
  -H "Authorization: Bearer WRONG_TOKEN"
```

Expected HTTP status: `401`.
