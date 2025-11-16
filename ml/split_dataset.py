import numpy as np
from sklearn.model_selection import train_test_split

X = np.load("data/features/X.npy")
y = np.load("data/features/y.npy")

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.3, random_state=42
)

np.save("data/features/X_train.npy", X_train)
np.save("data/features/X_test.npy", X_test)
np.save("data/features/y_train.npy", y_train)
np.save("data/features/y_test.npy", y_test)

print("Split complete:")
print("Train:", len(X_train), "samples")
print("Test:", len(X_test), "samples")
