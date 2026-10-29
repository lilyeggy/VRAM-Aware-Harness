import json
import re
import time
import uuid
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import uvicorn
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_PATH = "/data/day-01-workspace/models/qwen3-1.7b"
DEVICE = "cuda:0"

print(f"Loading tokenizer and model from {MODEL_PATH} on {DEVICE}...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_PATH,
    torch_dtype=torch.bfloat16,
    device_map=DEVICE
)
print("Model loaded successfully!")

app = FastAPI(title="Local Qwen3 OpenAI API Server")

@app.get("/health")
def health():
    return {"status": "ok", "gpu_vram_mb": round(torch.cuda.memory_allocated() / 1024**2)}

@app.get("/v1/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "qwen3-1.7b",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "local"
            }
        ]
    }

def parse_model_output(raw_text):
    think_match = re.search(r"<think>(.*?)</think>", raw_text, re.DOTALL)
    reasoning = think_match.group(1).strip() if think_match else ""
    
    clean_text = re.sub(r"<think>.*?</think>", "", raw_text, flags=re.DOTALL).strip()
    
    tool_calls = []
    tool_matches = re.findall(r"<tool_call>\s*(.*?)\s*</tool_call>", clean_text, re.DOTALL)
    if tool_matches:
        for tm in tool_matches:
            try:
                call_data = json.loads(tm)
                tool_calls.append({
                    "id": f"call_{uuid.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {
                        "name": call_data.get("name", ""),
                        "arguments": json.dumps(call_data.get("arguments", {}), ensure_ascii=False) if isinstance(call_data.get("arguments"), dict) else str(call_data.get("arguments", ""))
                    }
                })
            except Exception as e:
                print(f"Failed to parse tool call JSON: {tm}, err: {e}")
        clean_text = re.sub(r"<tool_call>.*?</tool_call>", "", clean_text, flags=re.DOTALL).strip()
        
    return clean_text, reasoning, tool_calls

@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    tools = body.get("tools", None)
    stream = body.get("stream", False)
    max_tokens = body.get("max_tokens") or body.get("max_completion_tokens") or 1024
    
    # 构造 chat template
    if tools:
        prompt_text = tokenizer.apply_chat_template(
            messages,
            tools=tools,
            tokenize=False,
            add_generation_prompt=True
        )
    else:
        prompt_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )
        
    inputs = tokenizer([prompt_text], return_tensors="pt").to(DEVICE)
    input_len = inputs.input_ids.shape[1]
    
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            pad_token_id=tokenizer.eos_token_id,
            do_sample=False
        )
        
    gen_tokens = outputs[0][input_len:]
    output_text = tokenizer.decode(gen_tokens, skip_special_tokens=False)
    
    content, reasoning, tool_calls = parse_model_output(output_text)
    finish_reason = "tool_calls" if tool_calls else "stop"
    cmpl_id = f"chatcmpl-{uuid.uuid4().hex}"
    created_ts = int(time.time())
    
    if not stream:
        res = {
            "id": cmpl_id,
            "object": "chat.completion",
            "created": created_ts,
            "model": "qwen3-1.7b",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                        **({"tool_calls": tool_calls} if tool_calls else {}),
                        **({"reasoning_content": reasoning} if reasoning else {})
                    },
                    "finish_reason": finish_reason
                }
            ],
            "usage": {
                "prompt_tokens": input_len,
                "completion_tokens": len(gen_tokens),
                "total_tokens": input_len + len(gen_tokens)
            }
        }
        return JSONResponse(res)
    else:
        async def event_generator():
            init_chunk = {
                "id": cmpl_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": "qwen3-1.7b",
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant"},
                    "finish_reason": None
                }]
            }
            yield f"data: {json.dumps(init_chunk, ensure_ascii=False)}\n\n"
            
            if reasoning:
                reason_chunk = {
                    "id": cmpl_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": "qwen3-1.7b",
                    "choices": [{
                        "index": 0,
                        "delta": {"reasoning_content": reasoning},
                        "finish_reason": None
                    }]
                }
                yield f"data: {json.dumps(reason_chunk, ensure_ascii=False)}\n\n"
                
            if content:
                content_chunk = {
                    "id": cmpl_id,
                    "object": "chat.completion.chunk",
                    "created": created_ts,
                    "model": "qwen3-1.7b",
                    "choices": [{
                        "index": 0,
                        "delta": {"content": content},
                        "finish_reason": None
                    }]
                }
                yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"
                
            if tool_calls:
                for idx, tc in enumerate(tool_calls):
                    tc_chunk = {
                        "id": cmpl_id,
                        "object": "chat.completion.chunk",
                        "created": created_ts,
                        "model": "qwen3-1.7b",
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "tool_calls": [{
                                    "index": idx,
                                    "id": tc["id"],
                                    "type": "function",
                                    "function": {
                                        "name": tc["function"]["name"],
                                        "arguments": tc["function"]["arguments"]
                                    }
                                }]
                            },
                            "finish_reason": None
                        }]
                    }
                    yield f"data: {json.dumps(tc_chunk, ensure_ascii=False)}\n\n"
                    
            final_chunk = {
                "id": cmpl_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": "qwen3-1.7b",
                "choices": [{
                    "index": 0,
                    "delta": {},
                    "finish_reason": finish_reason
                }],
                "usage": {
                    "prompt_tokens": input_len,
                    "completion_tokens": len(gen_tokens),
                    "total_tokens": input_len + len(gen_tokens)
                }
            }
            yield f"data: {json.dumps(final_chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            
        return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
