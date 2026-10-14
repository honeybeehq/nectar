from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return "<!doctype html><title>FastAPI fixture</title><h1>Hello from the Nectar FastAPI fixture</h1>"
