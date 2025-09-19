import axios from "axios";

// For text/story
const res = await axios.post("http://localhost:5000/api/generate-text", {
  prompt: "Describe this basket in a cultural story",
});
setOutput(res.data);

// For Imagen
const imgRes = await axios.post("http://localhost:5000/api/generate-image", {
  prompt: "A beautiful handwoven bamboo basket photo",
});
setPhoto(imgRes.data.url);
