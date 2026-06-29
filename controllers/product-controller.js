const sharp = require('sharp');
const { AppError } = require('../utils/app-error');
const { ApiFeatures } = require('../utils/api-features');
const { multerUpload } = require('../utils/multer-config');
const { createClient } = require('@supabase/supabase-js');

const Product = require('../models/product-model');
const Category = require('../models/category-model');
const Subcategory = require('../models/subcategory-model');

const productsThumbnailsDefault = 'products-thumbnails-default.jpeg';
const productsImagesDefault = ['products-images-default.jpeg'];

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

//** Services
const uploadProductImages = multerUpload.fields([
  { name: 'thumbnail', maxCount: 1 },
  { name: 'images', maxCount: 10 }
]);

// ✅ fixed
const resizeProductImages = async (productId, files) => {
  const { images = [] } = files;
  if (!images.length) return images;

  const resizedImages = await Promise.all(
    images.map(async (image, index) => {
      const imageFilename = `products-${productId}-${Date.now()}-${index + 1}.jpeg`;

      const resizedBuffer = await sharp(image.buffer)
        .resize(2000, 1300)
        .toFormat('jpeg')
        .jpeg({ quality: 95 })
        .toBuffer();

      const { error } = await supabase.storage
        .from('products')
        .upload(`images/${imageFilename}`, resizedBuffer, {
          contentType: 'image/jpeg'
        });

      if (error) throw new AppError(500, error.message);

      const { data: urlData } = supabase.storage
        .from('products')
        .getPublicUrl(`images/${imageFilename}`);

      return urlData.publicUrl;
    })
  );

  return resizedImages;
};

// ✅ fixed
const resizeProductThumbnail = async (productId, files) => {
  const { thumbnail = [] } = files;
  if (!thumbnail.length) return null;

  const thumbnailFilename = `products-${productId}-${Date.now()}.jpeg`;

  const resizedBuffer = await sharp(thumbnail[0].buffer)
    .resize(1500, 800)
    .toFormat('jpeg')
    .jpeg({ quality: 95 })
    .toBuffer();

  const { error } = await supabase.storage
    .from('products')
    .upload(`thumbnails/${thumbnailFilename}`, resizedBuffer, {
      contentType: 'image/jpeg'
    });

  if (error) throw new AppError(500, error.message);

  const { data: urlData } = supabase.storage
    .from('products')
    .getPublicUrl(`thumbnails/${thumbnailFilename}`);

  return urlData.publicUrl;
};

//** Controllers
const getAllProducts = async (req, res, next) => {
  const productsModel = new ApiFeatures(Product.find({}), req.query)
    .limitFields()
    .paginate()
    .filter()
    .sort();

  const products = await productsModel.model;

  const { page = 1, limit = 10 } = req.query;
  const totalModels = new ApiFeatures(Product.find(), req.query).filter();
  const total = await totalModels.model;
  const totalPages = Math.ceil(total.length / Number(limit));

  res.status(200).json({
    status: 'success',
    page: Number(page),
    per_page: Number(limit),
    total: total.length,
    total_pages: totalPages,
    data: { products }
  });
};

const addProduct = async (req, res, next) => {
  const {
    category: categoryId,
    subcategory: subcategoryId,
    name: productName,
    price, quantity, brand, description, rating
  } = req.body;

  const isProductExists = await Product.exists({ name: productName });
  if (isProductExists) {
    return next(new AppError(409, 'product name is already exists. choose a different product name'));
  }

  const category = await Category.findById(categoryId);
  if (!category) return next(new AppError(404, `category: ${categoryId} not found`));

  const subcategory = await Subcategory.findById(subcategoryId);
  if (!subcategory) return next(new AppError(404, `subcategory: ${subcategoryId} not found`));

  if (subcategory.category.toString() !== categoryId.toString()) {
    return next(new AppError(409, `category: ${categoryId} and subcategory: ${subcategoryId} not related`));
  }

  const product = await Product.create({
    category: categoryId,
    subcategory: subcategoryId,
    name: productName,
    price, quantity, brand, description, rating
  });

  const thumbnail = await resizeProductThumbnail(product._id, req.files);
  const images = await resizeProductImages(product._id, req.files);

  product.images = images.length ? images : productsImagesDefault;
  product.thumbnail = thumbnail ?? productsThumbnailsDefault;
  await product.save({ validateModifiedOnly: true });

  res.status(201).json({ status: 'success', data: { product } });
};

const getProductById = async (req, res, next) => {
  const { id: productId } = req.params;

  const product = await Product.findById(productId)
    .populate('category')
    .populate('subcategory');

  if (!product) return next(new AppError(404, `product: ${productId} not found`));

  res.status(200).json({ status: 'success', data: { product } });
};

const editProductById = async (req, res, next) => {
  const { id: productId } = req.params;
  const {
    category: categoryId = null,
    subcategory: subcategoryId = null,
    name: productName = null,
    price = null, quantity = null, brand = null,
    description = null, rating = null
  } = req.body;

  const product = await Product.findById(productId)
    .populate('category')
    .populate('subcategory');

  if (!product) return next(new AppError(404, `product: ${productId} not found`));

  const duplicateProduct = await Product.findOne({ name: productName });
  if (!!duplicateProduct && duplicateProduct.name !== product.name) {
    return next(new AppError(409, 'product name is already exists. choose a different product name'));
  }

  let category = await Category.findById(categoryId);
  if (!!categoryId && !category) return next(new AppError(404, `category: ${categoryId} not found`));

  let subcategory = await Subcategory.findById(subcategoryId);
  if (!!subcategoryId && !subcategory) return next(new AppError(404, `subcategory: ${subcategoryId} not found`));

  category ??= product.category;
  subcategory ??= product.subcategory;

  if (subcategory.category.toString() !== category._id.toString()) {
    return next(new AppError(409, `category: ${category._id} and subcategory: ${subcategory._id} not related`));
  }

  // ✅ حذف فایل قدیمی از Supabase
  const thumbnail = await resizeProductThumbnail(productId, req.files ?? {});
  if (!!thumbnail && product.thumbnail !== productsThumbnailsDefault) {
    const oldPath = product.thumbnail.split('/').pop();
    await supabase.storage.from('products').remove([`thumbnails/${oldPath}`]);
  }

  const images = await resizeProductImages(productId, req.files ?? {});
  if (images.length && !product.images.includes(productsImagesDefault[0])) {
    const oldPaths = product.images.map(img => `images/${img.split('/').pop()}`);
    await supabase.storage.from('products').remove(oldPaths);
  }

  product.category = category._id;
  product.subcategory = subcategory._id;
  product.name = productName ?? product.name;
  product.price = price ?? product.price;
  product.quantity = quantity ?? product.quantity;
  product.brand = brand ?? product.brand;
  product.description = description ?? product.description;
  product.rating = rating ?? product.rating;
  product.thumbnail = thumbnail ?? product.thumbnail;
  product.images = images.length ? images : product.images;

  await product.save({ validateBeforeSave: true });

  res.status(200).json({ status: 'success', data: { product } });
};

const removeProductById = async (req, res, next) => {
  const { id: productId } = req.params;

  const product = await Product.findByIdAndDelete(productId);
  if (!product) return next(new AppError(404, `product: ${productId} not found`));

  // ✅ حذف از Supabase
  if (product.thumbnail !== productsThumbnailsDefault) {
    const oldPath = product.thumbnail.split('/').pop();
    await supabase.storage.from('products').remove([`thumbnails/${oldPath}`]);
  }

  if (!product.images.includes(productsImagesDefault[0])) {
    const oldPaths = product.images.map(img => `images/${img.split('/').pop()}`);
    await supabase.storage.from('products').remove(oldPaths);
  }

  res.status(200).json({ status: 'success', data: { product } });
};

module.exports = {
  addProduct,
  getAllProducts,
  getProductById,
  editProductById,
  removeProductById,
  uploadProductImages
};